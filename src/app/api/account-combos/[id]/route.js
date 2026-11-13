import { NextResponse } from "next/server";
import { getAccountComboById, updateAccountCombo, deleteAccountCombo } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/account-combos/[id]
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const item = await getAccountComboById(id);
    if (!item) {
      return NextResponse.json({ error: "Account combo not found" }, { status: 404 });
    }
    return NextResponse.json(item);
  } catch (error) {
    console.log("Error fetching account combo:", error);
    return NextResponse.json({ error: "Failed to fetch account combo" }, { status: 500 });
  }
}

// PUT /api/account-combos/[id]
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updated = await updateAccountCombo(id, body);
    if (!updated) {
      return NextResponse.json({ error: "Account combo not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (error) {
    console.log("Error updating account combo:", error);
    return NextResponse.json({ error: "Failed to update account combo" }, { status: 500 });
  }
}

// DELETE /api/account-combos/[id]
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const success = await deleteAccountCombo(id);
    if (!success) {
      return NextResponse.json({ error: "Account combo not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting account combo:", error);
    return NextResponse.json({ error: "Failed to delete account combo" }, { status: 500 });
  }
}
