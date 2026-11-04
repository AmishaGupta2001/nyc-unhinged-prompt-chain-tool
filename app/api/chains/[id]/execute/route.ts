
import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/";

async function gemini(
    model: string,
    key: string,
    prompt: string,
    image = false
) {
 const response = await fetch(
     `${GEMINI_URL}${model}:generateContent?key=${key}`,
     {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
       contents: [{ parts: [{ text: prompt }] }],
       generationConfig: image
           ? { responseModalities: ["TEXT", "IMAGE"] }
           : { temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(90000),
     }
 );

 const json = await response.json();

 if (!response.ok) {
  const error = new Error(
      json.error?.message || "Gemini request failed."
  ) as Error & { status?: number };

  error.status = response.status;
  throw error;
 }

 const parts = json.candidates?.[0]?.content?.parts || [];

 const text = parts
     .filter((p: { text?: string }) => p.text)
     .map((p: { text: string }) => p.text)
     .join("\n");

 const imagePart = parts.find(
     (p: { inlineData?: { data: string; mimeType: string } }) =>
         p.inlineData?.data
 );

 return {
  text,
  image: imagePart?.inlineData
      ? {
       data: imagePart.inlineData.data,
       mimeType: imagePart.inlineData.mimeType,
      }
      : null,
 };
}

export async function POST(request: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin();

 if (auth.response) return auth.response;

 const { id } = await params;

 const key = process.env.GEMINI_API_KEY;

 if (!key) {
  return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server." },
      { status: 500 }
  );
 }

 let input: string;

 try {
  const body = await request.json();
  input = String(body.input ?? "");
 } catch {
  return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
  );
 }

 const { data: chain, error: chainError } = await auth.supabase
     .from("prompt_chains")
     .select("*")
     .eq("id", id)
     .single();

 if (chainError || !chain) {
  return NextResponse.json(
      { error: chainError?.message || "Chain not found." },
      { status: 404 }
  );
 }

 if (!chain.enabled) {
  return NextResponse.json(
      { error: "This chain is disabled. Enable it before running." },
      { status: 400 }
  );
 }

 const { data: steps, error } = await auth.supabase
     .from("prompt_chain_steps")
     .select("*")
     .eq("chain_id", id)
     .eq("enabled", true)
     .order("step_order");

 if (error) {
  return NextResponse.json({ error: error.message }, { status: 500 });
 }

 if (!steps?.length) {
  return NextResponse.json(
      { error: "Add at least one enabled step first." },
      { status: 400 }
  );
 }

 const textModel =
     process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

 const imageModel =
     process.env.GEMINI_IMAGE_MODEL ||
     "gemini-2.0-flash-preview-image-generation";

 // Build all stages into ONE text-generation request.
 const stages = steps.map((step, index) => {
  const template = String(step.prompt_template)
      .replaceAll("{{input}}", input)
      .replaceAll("{{chain_name}}", String(chain.name))
      .replaceAll("{{previous_output}}",
          index === 0
              ? input
              : `[Use the complete output of stage ${index} as context.]`
      );

  return `STAGE ${index + 1}: ${step.name}\n${template}`;
 });

 const combinedPrompt = `
You are executing a multi-stage AI prompt chain.

Chain name: ${chain.name}

Original user input:
${input}

Execute the following stages IN ORDER.

For each stage:
1. Follow its instructions.
2. Use the original input and the output of the preceding stage.
3. Preserve all useful information from previous stages.
4. Pass your complete result to the next stage.

${stages.join("\n\n")}

Return ONLY valid JSON in this exact structure:
{
  "outputs": [
    {
      "step": "stage name",
      "output": "complete stage output"
    }
  ],
  "final_output": "complete final stage output"
}

Include one output for every stage, in the original order.
Do not omit stages.
`;

 try {
  // ONE text request for all stages.
  const textResult = await gemini(
      textModel,
      key,
      combinedPrompt
  );

  let parsed: {
   outputs: { step: string; output: string }[];
   final_output: string;
  };

  try {
   const cleaned = textResult.text
       .replace(/^```(?:json)?\s*/i, "")
       .replace(/\s*```$/, "");

   parsed = JSON.parse(cleaned);
  } catch {
   return NextResponse.json(
       {
        error: "Gemini returned an invalid chain response. No automatic retry was made.",
       },
       { status: 502 }
   );
  }

  if (
      !Array.isArray(parsed.outputs) ||
      parsed.outputs.length !== steps.length ||
      !parsed.final_output
  ) {
   return NextResponse.json(
       { error: "Gemini returned incomplete chain results. No automatic retry was made." },
       { status: 502 }
   );
  }

  const outputs = parsed.outputs;
  const finalPrompt = parsed.final_output;

  // ONE image request after successful text generation.
  const imagePrompt = `
Create a polished visual based on this creative brief.
Return an image.

${finalPrompt}
`;

  const imageResult = await gemini(
      imageModel,
      key,
      imagePrompt,
      true
  );

  if (!imageResult.image) {
   return NextResponse.json(
       {
        error: "Text generation succeeded, but image generation returned no image.",
        outputs,
        finalPrompt,
       },
       { status: 502 }
   );
  }

  return NextResponse.json({
   outputs,
   image: imageResult.image,
   finalPrompt,
  });

 } catch (e) {
  const error = e as Error & { status?: number };

  if (error.status === 429) {
   return NextResponse.json(
       {
        error: "Gemini quota exceeded. No retry was attempted. Wait for your quota to reset.",
        code: "QUOTA_EXCEEDED",
       },
       { status: 429 }
   );
  }

  if (error.status === 503 || error.status === 500) {
   return NextResponse.json(
       {
        error: "Gemini is temporarily unavailable or overloaded. No retry was attempted.",
        code: "GEMINI_UNAVAILABLE",
       },
       { status: error.status }
   );
  }

  return NextResponse.json(
      {
       error: error.message || "Chain execution failed. No automatic retry was attempted.",
      },
      { status: error.status || 502 }
  );
 }
}
