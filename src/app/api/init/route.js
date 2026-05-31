import initializeApp from "@/shared/services/initializeApp";

// This API route is called by the CLI in headless/tray mode to initialize
// background services without requiring a dashboard page render.
export async function GET() {
  try {
    await initializeApp();
    return Response.json({ ok: true, initialized: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error?.message || "Initialization failed" },
      { status: 500 }
    );
  }
}
