import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";

type Ctx = {
    params: Promise<{ id: string }>;
};

type GeminiError = Error & {
    status?: number;
};

type InputImage = {
    data: string;
    mimeType: string;
};

const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/";

const ALLOWED_IMAGE_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
];

async function gemini(
    model: string,
    key: string,
    prompt: string,
    inputImage?: InputImage,
    generateImage = false
) {
    const parts: Record<string, unknown>[] = [];

    if (inputImage) {
        parts.push({
            inlineData: {
                mimeType: inputImage.mimeType,
                data: inputImage.data,
            },
        });
    }

    parts.push({ text: prompt });

    const response = await fetch(
        `${GEMINI_URL}${model}:generateContent?key=${key}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: generateImage
                    ? { responseModalities: ["TEXT", "IMAGE"] }
                    : { temperature: 0.7 },
            }),
            signal: AbortSignal.timeout(90000),
        }
    );

    const responseBody = await response.text();

    let json: {
        error?: { message?: string };
        candidates?: {
            content?: {
                parts?: {
                    text?: string;
                    inlineData?: {
                        data: string;
                        mimeType: string;
                    };
                }[];
            };
        }[];
    } = {};

    try {
        json = JSON.parse(responseBody);
    } catch {
        // Keep the raw response for error diagnostics.
    }

    if (!response.ok) {
        const providerMessage =
            json.error?.message ||
            responseBody ||
            "Unknown Gemini error";

        console.error("[Gemini API Error]", {
            model,
            status: response.status,
            statusText: response.statusText,
            message: providerMessage,
            imageInput: Boolean(inputImage),
            imageGeneration: generateImage,
        });

        const error: GeminiError = new Error(providerMessage);
        error.status = response.status;
        throw error;
    }

    const responseParts =
        json.candidates?.[0]?.content?.parts || [];

    const text = responseParts
        .filter((part) => part.text)
        .map((part) => part.text!)
        .join("\n")
        .trim();

    const imagePart = responseParts.find(
        (part) => part.inlineData?.data
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

function renderTemplate(
    template: string,
    values: {
        input: string;
        previousOutput: string;
        chainName: string;
    }
) {
    return template
        .replaceAll("{{input}}", values.input)
        .replaceAll("{{previous_output}}", values.previousOutput)
        .replaceAll("{{chain_name}}", values.chainName);
}

export async function POST(
    request: Request,
    { params }: Ctx
) {
    const auth = await requireApiSuperadmin();

    if (auth.response) return auth.response;

    const { id } = await params;

    const key = process.env.GEMINI_API_KEY;

    if (!key) {
        return NextResponse.json(
            {
                error: "GEMINI_API_KEY is not configured on the server.",
            },
            { status: 500 }
        );
    }

    let input = "";
    let inputImage: InputImage | undefined;

    try {
        const body = await request.json();

        input = String(body.input ?? "").trim();

        if (body.image != null) {
            const image = body.image;

            if (
                typeof image !== "object" ||
                typeof image.data !== "string" ||
                typeof image.mimeType !== "string"
            ) {
                return NextResponse.json(
                    { error: "Invalid image data." },
                    { status: 400 }
                );
            }

            if (!ALLOWED_IMAGE_TYPES.includes(image.mimeType)) {
                return NextResponse.json(
                    {
                        error: "Only JPG, PNG and WebP images are supported.",
                    },
                    { status: 400 }
                );
            }

            if (
                !image.data ||
                image.data.length > 14_000_000 ||
                !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
            ) {
                return NextResponse.json(
                    {
                        error: "Invalid image data or image is too large. Maximum upload size is 10 MB.",
                    },
                    { status: 400 }
                );
            }

            inputImage = {
                data: image.data,
                mimeType: image.mimeType,
            };
        }
    } catch {
        return NextResponse.json(
            { error: "Invalid request body." },
            { status: 400 }
        );
    }

    if (!input && !inputImage) {
        return NextResponse.json(
            {
                error: "Enter some text or upload an image before running the chain.",
            },
            { status: 400 }
        );
    }

    const { data: chain, error: chainError } =
        await auth.supabase
            .from("prompt_chains")
            .select("*")
            .eq("id", id)
            .single();

    if (chainError || !chain) {
        return NextResponse.json(
            {
                error: chainError?.message || "Chain not found.",
            },
            { status: 404 }
        );
    }

    if (!chain.enabled) {
        return NextResponse.json(
            {
                error: "This chain is disabled. Enable it before running.",
            },
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
        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        );
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

    const outputs: {
        step: string;
        output: string;
    }[] = [];

    let previousOutput = input || "Analyze the attached image.";

    try {
        // Execute each enabled step separately and in order.
        for (let index = 0; index < steps.length; index++) {
            const step = steps[index];

            const template = renderTemplate(
                String(step.prompt_template),
                {
                    input: input || "See the attached image.",
                    previousOutput,
                    chainName: String(chain.name),
                }
            );

            const prompt = `
You are executing step ${index + 1} of a sequential prompt chain.

Chain: ${chain.name}
Step: ${step.name}

Original user input:
${input || "(The user supplied an image instead of text.)"}

${index === 0
                ? "Use the attached image as the primary input for this step, if an image was supplied."
                : `The actual output from the previous step is:\n${previousOutput}`}

Instructions for this step:
${template}

Complete this step only.
Do not attempt to execute future steps.
Return the complete result as plain text.
`;

            console.log("[Chain Execution] Running step", {
                chainId: id,
                stepNumber: index + 1,
                stepName: step.name,
                hasImageInput: index === 0 && Boolean(inputImage),
            });

            const result = await gemini(
                textModel,
                key,
                prompt,
                index === 0 ? inputImage : undefined
            );

            if (!result.text) {
                throw new Error(
                    `Gemini returned an empty result for step ${index + 1}: ${step.name}`
                );
            }

            previousOutput = result.text;

            outputs.push({
                step: step.name,
                output: result.text,
            });
        }

        const finalPrompt = previousOutput;

        // Generate final media using the final step's actual output.
        const imagePrompt = `
Create a polished, visually compelling image based on the following creative brief.

Creative brief:
${finalPrompt}

Create the image itself. Do not simply describe it in text.
`;

        const imageResult = await gemini(
            imageModel,
            key,
            imagePrompt,
            undefined,
            true
        );

        if (!imageResult.image) {
            return NextResponse.json(
                {
                    error:
                        "All text steps completed, but Gemini did not return a generated image.",
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
        const error = e as GeminiError;

        console.error("[Chain Execution Error]", {
            status: error.status,
            message: error.message,
            completedSteps: outputs.length,
            totalSteps: steps.length,
        });

        if (error.status === 429) {
            return NextResponse.json(
                {
                    error:
                        "Gemini quota exceeded. No retry was attempted. Wait for your quota to reset.",
                    code: "QUOTA_EXCEEDED",
                    outputs,
                },
                { status: 429 }
            );
        }

        if (error.status === 503 || error.status === 500) {
            return NextResponse.json(
                {
                    error:
                        "Gemini is temporarily unavailable or overloaded. No retry was attempted.",
                    code: "GEMINI_UNAVAILABLE",
                    outputs,
                },
                { status: error.status }
            );
        }

        return NextResponse.json(
            {
                error:
                    error.message ||
                    "Chain execution failed. No automatic retry was attempted.",
                outputs,
            },
            { status: error.status || 502 }
        );
    }
}