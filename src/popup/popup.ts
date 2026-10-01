import { fetchAndParsePlaylist } from "../hls/playlist";
import { downloadAndConcat } from "../media/ffmpeg";
import type {
  DetectedVideo,
  DownloadEvent,
  DownloadJob,
  DownloadProgress,
  ExtensionRequest,
  ExtensionResponse,
  MediaVariant,
} from "../types";
import { errorMessage, formatBytes, formatDuration } from "../util";

const listElement = document.getElementById("video-list") as HTMLUListElement;
const statusElement = document.getElementById("status") as HTMLDivElement;
const clearButton = document.getElementById("clear-button") as HTMLButtonElement;

let currentTabId: number | null = null;
// titulo da pagina da nome melhor que a URL ("index.m3u8"); undefined cai no titulo derivado da URL
let currentTabTitle: string | undefined;

const MAX_TITLE_LENGTH = 60;

async function sendRequest(request: ExtensionRequest): Promise<ExtensionResponse> {
  return (await chrome.runtime.sendMessage(request)) as ExtensionResponse;
}

async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw new Error("Nao foi possivel identificar a aba atual.");
  }
  return tab;
}

async function requestVideosForTab(tabId: number): Promise<DetectedVideo[]> {
  const response = await sendRequest({ type: "GET_VIDEOS", tabId });
  if (response.type !== "VIDEOS") throw new Error("Resposta inesperada do service worker.");
  return response.videos;
}

async function requestVariants(kind: "hls" | "dash", url: string): Promise<MediaVariant[]> {
  const response = await sendRequest({ type: "GET_VARIANTS", kind, url });
  if (response.type === "ERROR") throw new Error(response.message);
  if (response.type !== "VARIANTS") throw new Error("Resposta inesperada do service worker.");
  return response.variants;
}

function sanitizeFileName(name: string): string {
  // o chrome.downloads recusa caracteres de controle e nomes com ponto/espaco nas pontas
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "video";
}

function baseFileName(video: DetectedVideo): string {
  return (currentTabTitle || video.title).slice(0, MAX_TITLE_LENGTH);
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function formatFetching(progress: DownloadProgress, startedAt: number): string {
  const elapsed = (Date.now() - startedAt) / 1000;
  const speed = progress.bytes && elapsed > 0 ? `${formatBytes(progress.bytes / elapsed)}/s` : "";
  const { completed, total } = progress;
  if (!completed) return "Baixando video...";
  if (!total) return ["Baixando video...", formatBytes(progress.bytes ?? 0), speed].filter(Boolean).join(" · ");
  const percent = Math.floor((completed / total) * 100);
  const eta = formatDuration((elapsed / completed) * (total - completed));
  return [`Baixando ${percent}%`, speed, eta && `${eta} restantes`].filter(Boolean).join(" · ");
}

function formatProgress(progress: DownloadProgress, startedAt: number): string {
  switch (progress.phase) {
    case "fetching":
      return formatFetching(progress, startedAt);
    case "remuxing":
      return "Remontando video (pode levar um tempo)...";
    case "saving":
      return "Salvando arquivo...";
  }
}

function setProgress(progressElement: HTMLElement, text: string, state?: "done" | "error"): void {
  progressElement.textContent = text;
  progressElement.classList.toggle("progress-done", state === "done");
  progressElement.classList.toggle("progress-error", state === "error");
}

function trackJob(jobId: string, progressElement: HTMLElement, onEnd: () => void): void {
  const startedAt = Date.now();
  const listener = (message: unknown): void => {
    const event = message as DownloadEvent;
    if (!event || typeof event !== "object" || !("jobId" in event) || event.jobId !== jobId) return;

    if (event.type === "DOWNLOAD_PROGRESS") {
      setProgress(progressElement, formatProgress(event.progress, startedAt));
      return;
    }

    chrome.runtime.onMessage.removeListener(listener);
    onEnd();
    if (event.type === "DOWNLOAD_DONE") {
      setProgress(progressElement, "Download concluido.", "done");
    } else {
      setProgress(progressElement, `Erro: ${event.message}`, "error");
    }
  };
  chrome.runtime.onMessage.addListener(listener);
}

async function startDownload(job: DownloadJob, progressElement: HTMLElement, onEnd: () => void): Promise<void> {
  setProgress(progressElement, "Iniciando...");
  trackJob(job.id, progressElement, onEnd);

  const response = await sendRequest({ type: "REQUEST_DOWNLOAD", job });
  if (response.type === "ERROR") {
    setProgress(progressElement, `Erro: ${response.message}`, "error");
    onEnd();
  }
}

function cancelJob(jobId: string): void {
  // o offscreen responde com DOWNLOAD_FAILED ("Download cancelado."), que libera o botao
  const request: ExtensionRequest = { type: "CANCEL_JOB", jobId };
  chrome.runtime.sendMessage(request).catch((error: unknown) => {
    console.warn("Falha ao cancelar download:", error);
  });
}

function bindDownload(button: HTMLButtonElement, progressElement: HTMLElement, buildJob: () => DownloadJob | null): void {
  let runningJobId: string | null = null;
  const finish = () => {
    runningJobId = null;
    button.textContent = "Baixar";
    button.disabled = false;
  };

  button.addEventListener("click", () => {
    if (runningJobId) {
      cancelJob(runningJobId);
      button.disabled = true;
      return;
    }
    const job = buildJob();
    if (!job) return;
    runningJobId = job.id;
    button.textContent = "Cancelar";
    startDownload(job, progressElement, finish).catch((error: unknown) => {
      setProgress(progressElement, `Erro: ${errorMessage(error)}`, "error");
      finish();
    });
  });
}

function populateVariantSelect(select: HTMLSelectElement, variants: MediaVariant[]): void {
  select.innerHTML = "";
  select.disabled = variants.length === 0;
  for (const variant of variants) {
    const option = document.createElement("option");
    const label = variant.audioOnly ? "So audio (m4a)" : variant.name;
    option.textContent = variant.size ? `${label} · ~${formatBytes(variant.size)}` : label;
    select.appendChild(option);
  }
}

function buildStreamJob(kind: "hls" | "dash", video: DetectedVideo, variant: MediaVariant): DownloadJob {
  const extension = variant.audioOnly ? "m4a" : "mp4";
  const filename = withExtension(sanitizeFileName(`${baseFileName(video)}-${variant.name}`), extension);
  return kind === "hls"
    ? { id: crypto.randomUUID(), kind: "hls", variantUrl: variant.id, audioVariantUrl: variant.audioUrl, filename }
    : { id: crypto.randomUUID(), kind: "dash", manifestUrl: video.url, representationId: variant.id, filename };
}

function createStreamControls(kind: "hls" | "dash", video: DetectedVideo, controls: HTMLDivElement, progressElement: HTMLElement): void {
  const select = document.createElement("select");
  select.disabled = true;
  const loadingOption = document.createElement("option");
  loadingOption.textContent = "Carregando qualidades...";
  select.appendChild(loadingOption);
  controls.appendChild(select);

  const downloadButton = document.createElement("button");
  downloadButton.textContent = "Baixar";
  downloadButton.disabled = true;
  controls.appendChild(downloadButton);

  let variants: MediaVariant[] = [];
  bindDownload(downloadButton, progressElement, () => {
    const variant = variants[select.selectedIndex];
    return variant ? buildStreamJob(kind, video, variant) : null;
  });

  requestVariants(kind, video.url)
    .then((loaded) => {
      variants = loaded;
      populateVariantSelect(select, variants);
      downloadButton.disabled = variants.length === 0;
    })
    .catch((error: unknown) => {
      setProgress(progressElement, `Erro ao carregar qualidades: ${errorMessage(error)}`, "error");
      select.innerHTML = "";
      const errorOption = document.createElement("option");
      errorOption.textContent = "Indisponivel";
      select.appendChild(errorOption);
    });
}

function createPlaceholderThumb(): HTMLDivElement {
  const placeholder = document.createElement("div");
  placeholder.className = "thumb thumb-placeholder";
  placeholder.textContent = "▶";
  return placeholder;
}

const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;

async function fetchThumbnailBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > THUMBNAIL_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Arquivo grande demais para gerar previa");
  }

  return response.blob();
}

async function fetchHlsPreviewBlob(masterUrl: string): Promise<Blob> {
  const master = await fetchAndParsePlaylist(masterUrl);
  const variantUrl =
    master.kind === "master" ? [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0]?.id : masterUrl;
  if (!variantUrl) throw new Error("Nenhuma qualidade disponivel para gerar previa.");

  const variant = await fetchAndParsePlaylist(variantUrl);
  if (variant.kind !== "variant" || variant.encrypted || !variant.initSegmentUrl) {
    throw new Error("Playlist HLS sem segmentos fMP4 compativeis com previa.");
  }

  const firstSegment = variant.segments[0];
  if (!firstSegment) throw new Error("Nenhum segmento disponivel para gerar previa.");

  const bytes = await downloadAndConcat([
    { url: variant.initSegmentUrl, range: variant.initSegmentRange },
    { url: firstSegment.url, range: firstSegment.range },
  ]);
  return new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
}

function fetchPreviewBlob(video: DetectedVideo): Promise<Blob> {
  return video.kind === "hls" ? fetchHlsPreviewBlob(video.url) : fetchThumbnailBlob(video.url);
}

function createThumbnail(video: DetectedVideo): HTMLElement {
  const placeholder = createPlaceholderThumb();
  if (video.kind === "dash") return placeholder;

  fetchPreviewBlob(video)
    .then((blob) => {
      const thumbVideo = document.createElement("video");
      thumbVideo.className = "thumb";
      thumbVideo.muted = true;
      thumbVideo.preload = "auto";
      thumbVideo.src = URL.createObjectURL(blob);
      thumbVideo.addEventListener(
        "loadedmetadata",
        () => {
          thumbVideo.currentTime = Math.min(1, thumbVideo.duration / 2 || 0.1);
        },
        { once: true },
      );
      thumbVideo.addEventListener(
        "error",
        () => {
          thumbVideo.replaceWith(createPlaceholderThumb());
        },
        { once: true },
      );
      placeholder.replaceWith(thumbVideo);
    })
    .catch((error: unknown) => {
      console.warn("Nao foi possivel gerar previa para", video.url, error);
    });

  return placeholder;
}

function createVideoItem(video: DetectedVideo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "video-item";
  item.appendChild(createThumbnail(video));

  const body = document.createElement("div");
  body.className = "video-body";
  item.appendChild(body);

  const title = document.createElement("div");
  title.className = "video-title";
  title.textContent = video.title;
  body.appendChild(title);

  const badge = document.createElement("span");
  badge.className = `badge badge-${video.kind}`;
  badge.textContent = video.kind.toUpperCase();
  title.appendChild(badge);

  const controls = document.createElement("div");
  controls.className = "controls";
  body.appendChild(controls);

  const progressElement = document.createElement("div");
  progressElement.className = "progress";
  body.appendChild(progressElement);

  if (video.kind === "mp4") {
    const downloadButton = document.createElement("button");
    downloadButton.textContent = "Baixar";
    controls.appendChild(downloadButton);
    bindDownload(downloadButton, progressElement, () => ({
      id: crypto.randomUUID(),
      kind: "mp4",
      url: video.url,
      filename: withExtension(sanitizeFileName(baseFileName(video)), "mp4"),
    }));
  } else {
    createStreamControls(video.kind, video, controls, progressElement);
  }

  return item;
}

async function refreshVideos(): Promise<void> {
  if (currentTabId === null) return;
  const videos = await requestVideosForTab(currentTabId);

  listElement.innerHTML = "";
  clearButton.disabled = videos.length === 0;

  if (videos.length === 0) {
    statusElement.textContent = "Nenhum video detectado nesta aba. Recarregue a pagina e reproduza o video.";
    return;
  }

  statusElement.textContent = `${videos.length} video(s) detectado(s).`;
  for (const video of videos) {
    listElement.appendChild(createVideoItem(video));
  }
}

async function handleClear(): Promise<void> {
  if (currentTabId === null) return;
  clearButton.disabled = true;
  const response = await sendRequest({ type: "CLEAR_TAB", tabId: currentTabId });
  if (response.type === "ERROR") throw new Error(response.message);
  await refreshVideos();
}

clearButton.addEventListener("click", () => {
  handleClear().catch((error: unknown) => {
    statusElement.textContent = `Erro ao limpar historico: ${errorMessage(error)}`;
    clearButton.disabled = false;
  });
});

async function init(): Promise<void> {
  const tab = await getCurrentTab();
  currentTabId = tab.id as number;
  currentTabTitle = tab.title?.trim() || undefined;
  await refreshVideos();
}

init().catch((error: unknown) => {
  statusElement.textContent = `Erro ao carregar videos: ${errorMessage(error)}`;
});
