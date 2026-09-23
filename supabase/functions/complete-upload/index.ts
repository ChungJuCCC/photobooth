import { handleCompleteUpload } from "../_shared/handlers.ts";
import { supabaseDeps } from "../_shared/supabase-deps.ts";

const deps = supabaseDeps();

Deno.serve((req) => handleCompleteUpload(req, deps));
