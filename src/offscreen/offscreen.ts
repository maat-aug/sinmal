import { fetchAndParsePlaylist } from "../hls/playlist";
import { remuxHlsToMp4 } from "../hls/remux";
import { fetchAndParseManifest, toMediaVariants } from "../dash/manifest";
import { remuxDashToMp4 } from "../dash/remux";
import type { DownloadEvent, DownloadJob, ExtensionRequest, ExtensionResponse } from "../types";
import { errorMessage } from "../util";

function isReceivingEndMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Receiving end does not exist");
}

function broadcast(event: DownloadEvent): void {
  chrome.runtime.sendMessage(event).catch((error: unknown) => {
    if (isReceivingEndMissing(error)) return;
    console.warn("Falha ao emitir evento de download:", error);
  });
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const request: ExtensionRequest = { type: "SAVE_BLOB_URL", url: blobUrl, filename };
    const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse;
    if (response.type === "ERROR") throw new Error(response.message);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

const PROGRESS_THROTTLE_MS = 250;

async function runMp4Job(job: Extract<DownloadJob, { kind: "mp4" }>, signal: AbortSignal): Promise<void> {
  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "fetching" } });

  const response = await fetch(job.url, { credentials: "include", signal });
  if (!response.ok || !response.body) {
    throw new Error(`Falha ao baixar o video (HTTP ${response.status}).`);
  }

  // le em pedacos para reportar progresso; response.blob() so avisa no fim
  const total = Number(response.headers.get("content-length")) || undefined;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  let lastBroadcast = 0;
  const reader = response.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value);
    bytes += chunk.value.length;
    if (Date.now() - lastBroadcast >= PROGRESS_THROTTLE_MS) {
      lastBroadcast = Date.now();
      broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "fetching", completed: bytes, total, bytes } });
    }
  }
  const blob = new Blob(chunks, { type: "video/mp4" });

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

async function fetchHlsVariantPlaylist(url: string, label: string) {
  const playlist = await fetchAndParsePlaylist(url);
  if (playlist.kind !== "variant") {
    throw new Error(`A playlist de ${label} nao contem segments reproduziveis.`);
  }
  return playlist;
}

async function runHlsJob(job: Extract<DownloadJob, { kind: "hls" }>, signal: AbortSignal): Promise<void> {
  const videoPlaylist = await fetchHlsVariantPlaylist(job.variantUrl, "video");
  const audioPlaylist = job.audioVariantUrl ? await fetchHlsVariantPlaylist(job.audioVariantUrl, "audio") : null;

  if (videoPlaylist.encrypted || audioPlaylist?.encrypted) {
    throw new Error("Este stream esta protegido/criptografado e nao pode ser baixado por esta extensao.");
  }

  const blob = await remuxHlsToMp4(
    videoPlaylist,
    audioPlaylist,
    (progress) => broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress }),
    signal,
  );

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

async function runDashJob(job: Extract<DownloadJob, { kind: "dash" }>, signal: AbortSignal): Promise<void> {
  const manifest = await fetchAndParseManifest(job.manifestUrl);
  const video = manifest.video.find((representation) => representation.id === job.representationId);
  // a opcao "so audio" aponta para uma representacao de audio: vira a unica faixa
  const audioOnly = video ? undefined : manifest.audio.find((representation) => representation.id === job.representationId);
  const main = video ?? audioOnly;
  if (!main) {
    throw new Error("A qualidade selecionada nao foi encontrada no manifesto DASH.");
  }
  const audio = audioOnly ? null : (manifest.audio[0] ?? null);

  const blob = await remuxDashToMp4(
    main,
    audio,
    (progress) => broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress }),
    signal,
  );

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

const runningJobs = new Map<string, AbortController>();

async function runJob(job: DownloadJob): Promise<void> {
  const controller = new AbortController();
  runningJobs.set(job.id, controller);
  try {
    if (job.kind === "mp4") {
      await runMp4Job(job, controller.signal);
    } else if (job.kind === "hls") {
      await runHlsJob(job, controller.signal);
    } else {
      await runDashJob(job, controller.signal);
    }
    broadcast({ type: "DOWNLOAD_DONE", jobId: job.id });
  } catch (error) {
    const message = controller.signal.aborted ? "Download cancelado." : errorMessage(error);
    broadcast({ type: "DOWNLOAD_FAILED", jobId: job.id, message });
  } finally {
    runningJobs.delete(job.id);
  }
}

async function handleParseDashManifest(url: string): Promise<ExtensionResponse> {
  try {
    const manifest = await fetchAndParseManifest(url);
    return { type: "VARIANTS", variants: toMediaVariants(manifest) };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, _sender, sendResponse) => {
  if (message.type === "RUN_DOWNLOAD_JOB") {
    runJob(message.job).catch((error: unknown) => {
      console.error("Falha inesperada ao executar job de download:", error);
    });
    return false;
  }

  if (message.type === "CANCEL_JOB") {
    runningJobs.get(message.jobId)?.abort();
    return false;
  }

  if (message.type === "PARSE_DASH_MANIFEST") {
    handleParseDashManifest(message.url).then(sendResponse);
    return true;
  }

  return false;
});
