export type { NewsItem } from "@/types/api.news";

export interface DashboardForecastDay {
  fxDate: string;
  dayName: string;
  icon: string;
  tempMin: number;
  tempMax: number;
  text: string;
}

export interface DashboardWeatherDisplay {
  icon: string;
  temp: number | null;
  text: string;
  humidity: number | null;
  wind: string;
  pressure: number | null;
  forecast: DashboardForecastDay[];
}
