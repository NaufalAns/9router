import { NextResponse } from "next/server";
import { getAccountCombos, createAccountCombo } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/account-combos
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const filter = {};
    if (provider) filter.provider = provider;
    if (model) filter.model = model;

    const accountCombos = await getAccountCombos(filter);
    return NextResponse.json({ accountCombos });
  } catch (error) {
    console.log("Error fetching account combos:", error);
    return NextResponse.json({ error: "Failed to fetch account combos" }, { status: 500 });
  }
}

// POST /api/account-combos
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, model, provider, connectionIds, fallbackMode, isActive } = body;

    if (!model || typeof model !== "string" || !model.trim()) {
      return NextResponse.json({ error: "Model is required" }, { status: 400 });
    }

    if (!provider || typeof provider !== "string" || !provider.trim()) {
      return NextResponse.json({ error: "Provider is required" }, { status: 400 });
    }

    const created = await createAccountCombo({
      name: name?.trim() || null,
      model: model.trim(),
      provider: provider.trim(),
      connectionIds: Array.isArray(connectionIds) ? connectionIds : [],
      fallbackMode: fallbackMode === "default" ? "default" : "strict",
      isActive: isActive !== false,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.log("Error creating account combo:", error);
    return NextResponse.json({ error: "Failed to create account combo" }, { status: 500 });
  }
}
