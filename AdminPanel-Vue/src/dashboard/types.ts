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
  temp: number;
  text: string;
  humidity: number;
  wind: string;
  pressure: number;
  forecast: DashboardForecastDay[];
}
