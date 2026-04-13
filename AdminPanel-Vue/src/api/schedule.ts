import {
  requestWithUi,
  type RequestUiOptions,
} from "./requestWithUi";

const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export interface Schedule {
  id: string;
  time: string;
  content: string;
}

type SchedulesResponse =
  | Schedule[]
  | {
      schedules?: Schedule[];
    };

function normalizeSchedulesResponse(response: SchedulesResponse): Schedule[] {
  return Array.isArray(response) ? response : response.schedules || [];
}

export const scheduleApi = {
  async getSchedules(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<Schedule[]> {
    const response = await requestWithUi<SchedulesResponse>(
      {
        url: "/admin_api/schedules",
      },
      uiOptions
    );
    return normalizeSchedulesResponse(response);
  },

  async createSchedule(
    payload: Pick<Schedule, "time" | "content">,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: "/admin_api/schedules",
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async deleteSchedule(
    id: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<void> {
    await requestWithUi(
      {
        url: `/admin_api/schedules/${encodeURIComponent(id)}`,
        method: "DELETE",
      },
      uiOptions
    );
  },
};

