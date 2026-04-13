import {
  requestWithUi,
  type HttpRequestContext,
  type RequestUiOptions,
} from "./requestWithUi";
import type { WeatherResponse } from "@/types/api.weather";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };
export type { DailyWeather, HourlyWeather } from "@/types/api.weather";
export type WeatherData = WeatherResponse;

export const weatherApi = {
  async getWeather(
    requestContext: HttpRequestContext = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<WeatherResponse> {
    return requestWithUi(
      {
        url: "/admin_api/weather",
        ...requestContext,
      },
      uiOptions
    );
  },
};

