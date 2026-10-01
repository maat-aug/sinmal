import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegInstance: FFmpeg | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    classWorkerURL: chrome.runtime.getURL("ffmpeg-worker.js"),
    coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

/** Mata um exec em andamento (unico jeito de parar o ffmpeg.wasm no meio); o proximo getFFmpeg() carrega outro. */
export function terminateFFmpeg(): void {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
}

export interface ByteSource {
  url: string;
  range?: { offset: number; length: number };
}

const MAX_ATTEMPTS = 3;

// 4xx (exceto 408/429) nao se resolve sozinho: URL assinada expirada continua expirada
const isRetryableStatus = (status: number) => status >= 500 || status === 408 || status === 429;

export async function downloadBytes(source: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  const headers = source.range
    ? { Range: `bytes=${source.range.offset}-${source.range.offset + source.range.length - 1}` }
    : undefined;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(source.url, { credentials: "include", headers, signal });
    } catch (error) {
      // erro de rede (conexao caiu, timeout): vale tentar de novo
      if (signal?.aborted || attempt >= MAX_ATTEMPTS) throw error;
      await delay(attempt * 1000, signal);
      continue;
    }
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (!isRetryableStatus(response.status) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Falha ao baixar segmento (HTTP ${response.status}): ${source.url}`);
    }
    await delay(attempt * 1000, signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted(); // o evento "abort" nao dispara de novo para quem chega depois
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function downloadAndConcat(
  sources: ByteSource[],
  onSegment?: (completed: number, total: number, bytes: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!source) continue;
    const part = await downloadBytes(source, signal);
    parts.push(part);
    bytes += part.length;
    onSegment?.(i + 1, sources.length, bytes);
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

export async function execWithLog(
  ffmpeg: FFmpeg,
  args: string[],
  onProgress?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const onAbort = () => terminateFFmpeg();
  signal?.addEventListener("abort", onAbort, { once: true });
  const logLines: string[] = [];
  const handleLog = ({ message }: { type: string; message: string }) => {
    logLines.push(message);
    if (logLines.length > 40) logLines.shift();
  };
  const handleProgress = () => onProgress?.();

  ffmpeg.on("log", handleLog);
  ffmpeg.on("progress", handleProgress);

  let exitCode: number;
  try {
    exitCode = await ffmpeg.exec(args);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ffmpeg.off("log", handleLog);
    ffmpeg.off("progress", handleProgress);
  }
  signal?.throwIfAborted();

  if (exitCode !== 0) {
    const detail = logLines.slice(-6).join(" | ");
    throw new Error(
      `O ffmpeg terminou com codigo de erro ${exitCode} ao remontar o video.${detail ? ` Detalhes: ${detail}` : ""}`,
    );
  }
}

export async function readOutputAsBlob(ffmpeg: FFmpeg, fileName: string): Promise<Blob> {
  const outputData = await ffmpeg.readFile(fileName);
  if (!(outputData instanceof Uint8Array)) {
    throw new Error("Formato de saida inesperado ao ler o video remontado.");
  }
  return new Blob([new Uint8Array(outputData)], { type: "video/mp4" });
}

export async function cleanupFiles(ffmpeg: FFmpeg, fileNames: string[]): Promise<void> {
  if (!ffmpeg.loaded) return; // instancia encerrada (cancelamento): a memoria ja foi liberada
  for (const fileName of fileNames) {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch (error) {
      console.warn(`Nao foi possivel remover ${fileName} do sistema de arquivos do ffmpeg:`, error);
    }
  }
}
