export type VideoKind = "mp4" | "hls" | "dash";

export interface DetectedVideo {
  url: string;
  kind: VideoKind;
  contentType: string;
  tabId: number;
  title: string;
  detectedAt: number;
}

export interface MediaVariant {
  id: string;
  bandwidth: number;
  /** HLS AVERAGE-BANDWIDTH; BANDWIDTH e o pico e superestima o tamanho */
  averageBandwidth?: number;
  resolution?: string;
  name: string;
  audioUrl?: string;
  /** Bytes estimados, quando bitrate e duracao sao conhecidos. */
  size?: number;
  /** Faixa so de audio (salva como .m4a, sem recodificar). */
  audioOnly?: boolean;
}

export interface DownloadProgress {
  phase: "fetching" | "remuxing" | "saving";
  /** segmentos concluidos (HLS/DASH) ou bytes concluidos (MP4) */
  completed?: number;
  total?: number;
  /** bytes baixados ate agora, para calcular a velocidade */
  bytes?: number;
}

export type DownloadJob =
  | { id: string; kind: "mp4"; url: string; filename: string }
  | { id: string; kind: "hls"; variantUrl: string; audioVariantUrl?: string; filename: string }
  | { id: string; kind: "dash"; manifestUrl: string; representationId: string; filename: string };

export type ExtensionRequest =
  | { type: "GET_VIDEOS"; tabId: number }
  | { type: "CLEAR_TAB"; tabId: number }
  | { type: "GET_VARIANTS"; kind: "hls" | "dash"; url: string }
  | { type: "PARSE_DASH_MANIFEST"; url: string }
  | { type: "REQUEST_DOWNLOAD"; job: DownloadJob }
  | { type: "RUN_DOWNLOAD_JOB"; job: DownloadJob }
  | { type: "CANCEL_JOB"; jobId: string }
  | { type: "SAVE_BLOB_URL"; url: string; filename: string }
  | { type: "VIDEO_VISIBLE" };

export type ExtensionResponse =
  | { type: "VIDEOS"; videos: DetectedVideo[] }
  | { type: "VARIANTS"; variants: MediaVariant[] }
  | { type: "ERROR"; message: string }
  | { type: "OK" };

export type DownloadEvent =
  | { type: "DOWNLOAD_PROGRESS"; jobId: string; progress: DownloadProgress }
  | { type: "DOWNLOAD_DONE"; jobId: string }
  | { type: "DOWNLOAD_FAILED"; jobId: string; message: string };
