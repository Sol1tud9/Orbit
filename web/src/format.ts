import type { Reason } from "./types";

export const percent = (value: number) =>
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value * 100);
export const number = (value: number, digits = 0) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(
    value,
  );
export function time(seconds: number) {
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function duration(seconds: number) {
  if (seconds === 0) return "0 мин";
  if (seconds < 60) return `${seconds} с`;
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return [h ? `${h} ч` : "", m ? `${m} мин` : "", s ? `${s} с` : ""]
    .filter(Boolean)
    .join(" ");
}
export const reasonText: Record<Reason, string> = {
  connected: "Маршрут доступен",
  no_client_coverage: "Нет видимого спутника",
  all_gateways_offline: "Все шлюзы отключены",
  no_gateway_contact: "Нет контакта со шлюзом",
  isl_disconnected: "Разрыв спутниковой сети",
};
export const reasonColor: Record<Reason, string> = {
  connected: "#59d9c1",
  no_client_coverage: "#e5777f",
  all_gateways_offline: "#b898e8",
  no_gateway_contact: "#e7b671",
  isl_disconnected: "#e7b671",
};
