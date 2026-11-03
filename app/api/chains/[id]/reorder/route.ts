import { NextResponse } from 'next/server';
import { requireApiSuperadmin } from '@/lib/auth';
type Ctx = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin(); if (auth.response) return auth.response; const { id } = await params; const { orderedIds } = await request.json();
 if (!Array.isArray(orderedIds)) return NextResponse.json({ error: 'orderedIds must be an array.' }, { status: 400 });
 for (let i=0; i<orderedIds.length; i++) { const { error } = await auth.supabase.from('prompt_chain_steps').update({ step_order: i+1 }).eq('id', orderedIds[i]).eq('chain_id', id); if (error) return NextResponse.json({ error: error.message }, { status: 500 }); }
 return NextResponse.json({ ok: true });
}
