import { NextResponse } from 'next/server';
import { requireApiSuperadmin } from '@/lib/auth';
type Ctx = { params: Promise<{ id: string }> };
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
async function gemini(model: string, key: string, prompt: string, image = false) {
 const response = await fetch(`${GEMINI_URL}${model}:generateContent?key=${key}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig: image ? { responseModalities:['TEXT','IMAGE'] } : { temperature:0.7 } }) });
 const json = await response.json(); if (!response.ok) throw new Error(json.error?.message || 'Gemini request failed.');
 const parts = json.candidates?.[0]?.content?.parts || []; const text = parts.filter((p: {text?:string})=>p.text).map((p: {text:string})=>p.text).join('\n');
 const imagePart = parts.find((p: {inlineData?:{data:string,mimeType:string}})=>p.inlineData?.data);
 return { text, image: imagePart?.inlineData ? { data:imagePart.inlineData.data, mimeType:imagePart.inlineData.mimeType } : null };
}
export async function POST(request: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin(); if (auth.response) return auth.response; const { id } = await params;
 const key = process.env.GEMINI_API_KEY; if (!key) return NextResponse.json({ error:'GEMINI_API_KEY is not configured on the server.' }, { status:500 });
 const { input = '' } = await request.json();
 const { data: chain, error: chainError } = await auth.supabase.from('prompt_chains').select('*').eq('id',id).single();
 if (chainError || !chain) return NextResponse.json({ error:chainError?.message || 'Chain not found.' }, {status:404});
 if (!chain.enabled) return NextResponse.json({ error:'This chain is disabled. Enable it before running.' }, {status:400});
 const { data: steps, error } = await auth.supabase.from('prompt_chain_steps').select('*').eq('chain_id',id).eq('enabled',true).order('step_order');
 if (error) return NextResponse.json({error:error.message},{status:500}); if (!steps?.length) return NextResponse.json({error:'Add at least one enabled step first.'},{status:400});
 const textModel = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash'; const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-preview-image-generation';
 let previous = String(input); const outputs: {step:string, output:string}[] = [];
 try {
  for (const step of steps) { const prompt = String(step.prompt_template).replaceAll('{{input}}',String(input)).replaceAll('{{previous_output}}',previous).replaceAll('{{chain_name}}',chain.name);
   const result = await gemini(textModel,key,prompt); previous = result.text || previous; outputs.push({step:step.name,output:result.text}); }
  const imagePrompt = `Create a polished visual based on the following creative brief. Return an image.\n\n${previous}`;
  const imageResult = await gemini(imageModel,key,imagePrompt,true);
  if (!imageResult.image) return NextResponse.json({ error:'Gemini completed the text steps but did not return an image. Check GEMINI_IMAGE_MODEL and ensure it supports image generation.', outputs }, {status:502});
  return NextResponse.json({ outputs, image: imageResult.image, finalPrompt: previous });
 } catch (e) { return NextResponse.json({error:e instanceof Error ? e.message : 'Chain execution failed.'},{status:502}); }
}
