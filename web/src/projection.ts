export function globePoint(
  x: number,
  y: number,
  z: number,
  longitude: number,
  latitude: number,
) {
  const lon = (longitude * Math.PI) / 180,
    lat = (latitude * Math.PI) / 180;
  const horizontal = (-Math.sin(lon) * x + Math.cos(lon) * y) / 6371;
  const vertical =
    (-Math.sin(lat) * Math.cos(lon) * x -
      Math.sin(lat) * Math.sin(lon) * y +
      Math.cos(lat) * z) /
    6371;
  const depth =
    (Math.cos(lat) * Math.cos(lon) * x +
      Math.cos(lat) * Math.sin(lon) * y +
      Math.sin(lat) * z) /
    6371;
  return {
    x: 390 + 190 * horizontal,
    y: 258 - 190 * vertical,
    visible: depth >= 0 || Math.hypot(horizontal, vertical) > 1.0000001,
  };
}
