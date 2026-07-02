import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

export interface TarotPlanetSnapshot {
  planet: string;
  name_cn: string;
  x_au: number;
  y_au: number;
  z_au: number;
  angle_deg: number;
  distance_au: number;
}

export interface TarotCelestialSnapshot {
  sampled_at: string;
  diff_ms: number | null;
  planets: TarotPlanetSnapshot[];
}

export interface TarotCardDetail {
  position: string;
  meaning?: string;
  name: string;
  name_cn: string;
  suit: string;
  reversed: boolean;
  reversal_probability: number;
  image_url: string;
  mime_type: string;
  error?: string | null;
}

export interface TarotDivinationResult {
  content?: unknown;
  summary?: string;
  spread?: {
    command: string;
    name: string;
    positions: string[];
    origin: {
      type: string;
      name: string;
      description: string;
      symbol: string;
    };
  };
  details?: TarotCardDetail[];
}

export interface TarotApiResponse<T> {
  status: "success" | "error";
  result?: T;
  error?: string;
  details?: string;
}

export interface TarotInvokePayload {
  command: "draw_single_card" | "draw_three_card_spread" | "draw_celtic_cross";
  origin?: string;
  fate_check_number?: string | number;
}

const READ_OPTIONS: RequestUiOptions = {
  showLoader: false,
  suppressErrorMessage: true,
};

export const tarotDivinationApi = {
  async getCelestialSnapshot(
    origin?: string,
    uiOptions: RequestUiOptions = READ_OPTIONS
  ): Promise<TarotApiResponse<TarotCelestialSnapshot>> {
    return requestWithUi(
      {
        url: "/admin_api/tarot-divination/celestial-snapshot",
        query: { origin },
      },
      uiOptions
    );
  },

  async invoke(
    payload: TarotInvokePayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<TarotApiResponse<TarotDivinationResult>> {
    return requestWithUi(
      {
        url: "/admin_api/tarot-divination/invoke",
        method: "POST",
        body: payload,
        timeoutMs: 25000,
      },
      uiOptions
    );
  },
};