// Única parte que hay que editar para personalizar la web.
export const config = {
  trip: {
    name: "Nuestro viaje",
    destination: "Destino por definir",
    start: "2026-12-20", // AAAA-MM-DD; dejar "" si aún no hay fechas
    end: "2026-12-27",
    currency: "EUR",
  },

  map: {
    // Vista inicial mientras no haya lugares con ubicación: [longitud, latitud] y zoom.
    // Ahora apunta a Florida; cambiarlo al destino real.
    center: [-81.5, 27.8],
    zoom: 6,
    // Teselas gratuitas de OpenFreeMap (sin clave).
    styles: {
      light: "https://tiles.openfreemap.org/styles/liberty",
      dark: "https://tiles.openfreemap.org/styles/dark",
    },
  },

  // Dejar url y anonKey vacíos = modo demo (datos solo en este navegador).
  // La anon key es pública por diseño: la protección son las políticas RLS de supabase/schema.sql.
  // Nunca poner aquí la service_role key.
  supabase: {
    url: "",
    anonKey: "",
  },
};
