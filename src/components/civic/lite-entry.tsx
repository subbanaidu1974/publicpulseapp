/** PWA-lite entry: only the civic tab (no maps, no charts). Its gzip size is checked by tests/civic/channels.size.test.ts. */
import { createRoot } from "react-dom/client";
import { LangProvider } from "../../i18n";
import CivicHome from "./CivicHome";

createRoot(document.getElementById("root")!).render(<LangProvider><CivicHome /></LangProvider>);
