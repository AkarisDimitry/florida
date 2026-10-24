// Única parte que hay que editar para personalizar la web.
export const config = {
  trip: {
    name: "Nuestro viaje",
    destination: "Destino por definir",
    start: "2026-12-20", // AAAA-MM-DD; dejar "" si aún no hay fechas
    end: "2026-12-27",
    currency: "EUR",
  },

  // Dejar url y anonKey vacíos = modo demo (datos solo en este navegador).
  // La anon key es pública por diseño: la protección son las políticas RLS de supabase/schema.sql.
  // Nunca poner aquí la service_role key.
  supabase: {
    url: "",
    anonKey: "",
  },
};
