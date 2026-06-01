import initializeApp from "@/shared/services/initializeApp";

// This API route is called by the CLI in headless/tray mode to initialize
// background services without requiring a dashboard page render.
export async function GET() {
  try {
    const result = await initializeApp();
    if (result?.ok === false) {
      return Response.json(
        { ok: false, error: result.error || "Initialization failed" },
        { status: 500 }
      );
    }
    return Response.json({ ok: true, initialized: true, mitm: result?.mitm || null });
  } catch (error) {
    return Response.json(
      { ok: false, error: error?.message || "Initialization failed" },
      { status: 500 }
    );
  }
}
