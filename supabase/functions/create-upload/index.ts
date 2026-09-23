import { handleCreateUpload } from "../_shared/handlers.ts";
import { supabaseDeps } from "../_shared/supabase-deps.ts";

const deps = supabaseDeps();

Deno.serve((req) => handleCreateUpload(req, deps));
