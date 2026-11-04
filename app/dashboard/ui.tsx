"use client";

import {
 useCallback,
 useEffect,
 useMemo,
 useState,
} from "react";
import { signOut } from "next-auth/react";

type Chain = {
 id: string;
 name: string;
 description: string | null;
 enabled: boolean;
 created_at: string;
 updated_at: string;
};

type Step = {
 id: string;
 chain_id: string;
 step_order: number;
 name: string;
 prompt_template: string;
 enabled: boolean;
};

type Media = {
 id: string;
 chain_id: string;
 prompt: string;
 storage_path: string;
 created_at: string;
 url?: string;
};

type StepOutput = {
 step: string;
 output: string;
};

type GeneratedResult = {
 url: string;
 prompt: string;
 outputs: StepOutput[];
};

type ImagePayload = {
 data: string;
 mimeType: string;
};

async function api(
    url: string,
    method = "GET",
    body?: unknown
) {
 const response = await fetch(url, {
  method,
  headers: {
   "Content-Type": "application/json",
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
 });

 const json = await response.json().catch(() => ({}));

 if (!response.ok) {
  throw new Error(json.error || "Request failed");
 }

 return json;
}

function fileToBase64(file: File): Promise<ImagePayload> {
 return new Promise((resolve, reject) => {
  const reader = new FileReader();

  reader.onload = () => {
   const result = String(reader.result || "");
   const commaIndex = result.indexOf(",");

   if (commaIndex === -1) {
    reject(new Error("Could not read the selected image."));
    return;
   }

   resolve({
    data: result.slice(commaIndex + 1),
    mimeType: file.type,
   });
  };

  reader.onerror = () => {
   reject(new Error("Could not read the selected image."));
  };

  reader.readAsDataURL(file);
 });
}

export default function Dashboard({
                                   email,
                                  }: {
 email: string;
}) {
 const [chains, setChains] = useState<Chain[]>([]);
 const [selected, setSelected] = useState("");
 const [steps, setSteps] = useState<Step[]>([]);
 const [media, setMedia] = useState<Media[]>([]);

 const [tab, setTab] = useState<"chains" | "media">("chains");
 const [mediaFilter, setMediaFilter] = useState("all");

 const [chainName, setChainName] = useState("");
 const [chainDescription, setChainDescription] = useState("");
 const [stepName, setStepName] = useState("");
 const [template, setTemplate] = useState("");
 const [input, setInput] = useState("");

 const [imageFile, setImageFile] = useState<File | null>(null);
 const [imagePreview, setImagePreview] = useState("");

 const [editChain, setEditChain] = useState(false);
 const [creatingChain, setCreatingChain] = useState(false);
 const [editStep, setEditStep] = useState("");

 const [busy, setBusy] = useState(false);
 const [message, setMessage] = useState("");
 const [theme, setTheme] = useState("system");

 const [generated, setGenerated] =
     useState<GeneratedResult | null>(null);

 const active = chains.find((chain) => chain.id === selected);

 const loadChains = useCallback(async () => {
  try {
   const data = await api("/api/chains");
   setChains(data);
   setSelected((old) => old || data[0]?.id || "");
  } catch (error) {
   setMessage((error as Error).message);
  }
 }, []);

 const loadSteps = useCallback(async (id: string) => {
  if (!id) return;

  try {
   setSteps(await api(`/api/chains/${id}/steps`));
  } catch (error) {
   setMessage((error as Error).message);
  }
 }, []);

 const loadMedia = useCallback(async () => {
  try {
   setMedia(await api("/api/media"));
  } catch (error) {
   setMessage((error as Error).message);
  }
 }, []);

 useEffect(() => {
  loadChains();
  loadMedia();
 }, [loadChains, loadMedia]);

 useEffect(() => {
  loadSteps(selected);
 }, [selected, loadSteps]);

 useEffect(() => {
  document.documentElement.dataset.theme = theme;
 }, [theme]);

 useEffect(() => {
  if (!imageFile) {
   setImagePreview("");
   return;
  }

  const url = URL.createObjectURL(imageFile);
  setImagePreview(url);

  return () => URL.revokeObjectURL(url);
 }, [imageFile]);

 const notify = (text: string) => {
  setMessage(text);
  window.setTimeout(() => setMessage(""), 4500);
 };

 async function saveChain() {
  setBusy(true);

  try {
   if (editChain && active && !creatingChain) {
    await api(`/api/chains/${active.id}`, "PATCH", {
     name: chainName,
     description: chainDescription,
    });

    notify("Chain updated.");
   } else {
    const chain = await api("/api/chains", "POST", {
     name: chainName,
     description: chainDescription,
    });

    setSelected(chain.id);
    notify("Chain created.");
   }

   setChainName("");
   setChainDescription("");
   setEditChain(false);
   setCreatingChain(false);

   await loadChains();
  } catch (error) {
   notify((error as Error).message);
  } finally {
   setBusy(false);
  }
 }

 function startEditChain() {
  if (!active) return;

  setChainName(active.name);
  setChainDescription(active.description || "");
  setEditChain(true);
 }

 async function deleteChain() {
  if (
      !active ||
      !confirm(`Delete "${active.name}" and all its steps?`)
  ) {
   return;
  }

  try {
   await api(`/api/chains/${active.id}`, "DELETE");
   setSelected("");
   await loadChains();
   setSteps([]);
   notify("Chain deleted.");
  } catch (error) {
   notify((error as Error).message);
  }
 }

 async function saveStep() {
  if (!selected) return;

  setBusy(true);

  try {
   if (editStep) {
    await api(`/api/steps/${editStep}`, "PATCH", {
     name: stepName,
     prompt_template: template,
    });
   } else {
    await api(`/api/chains/${selected}/steps`, "POST", {
     name: stepName,
     prompt_template: template,
    });
   }

   setStepName("");
   setTemplate("");
   setEditStep("");

   await loadSteps(selected);
   notify("Step saved.");
  } catch (error) {
   notify((error as Error).message);
  } finally {
   setBusy(false);
  }
 }

 function editExistingStep(step: Step) {
  setEditStep(step.id);
  setStepName(step.name);
  setTemplate(step.prompt_template);
 }

 async function deleteStep(id: string) {
  if (!confirm("Delete this step?")) return;

  try {
   await api(`/api/steps/${id}`, "DELETE");
   await loadSteps(selected);
   notify("Step deleted.");
  } catch (error) {
   notify((error as Error).message);
  }
 }

 async function moveStep(index: number, delta: number) {
  const next = [...steps];
  const target = index + delta;

  if (target < 0 || target >= next.length) return;

  [next[index], next[target]] = [
   next[target],
   next[index],
  ];

  setSteps(next);

  try {
   await api(
       `/api/chains/${selected}/reorder`,
       "POST",
       {
        orderedIds: next.map((step) => step.id),
       }
   );
  } catch (error) {
   notify((error as Error).message);
   await loadSteps(selected);
  }
 }

 async function toggleChain() {
  if (!active) return;

  try {
   await api(`/api/chains/${active.id}`, "PATCH", {
    enabled: !active.enabled,
   });

   await loadChains();
  } catch (error) {
   notify((error as Error).message);
  }
 }

 async function toggleStep(step: Step) {
  try {
   await api(`/api/steps/${step.id}`, "PATCH", {
    enabled: !step.enabled,
   });

   await loadSteps(selected);
  } catch (error) {
   notify((error as Error).message);
  }
 }

 function handleImageChange(
     event: React.ChangeEvent<HTMLInputElement>
 ) {
  const file = event.target.files?.[0];

  if (!file) return;

  const allowedTypes = [
   "image/jpeg",
   "image/png",
   "image/webp",
  ];

  if (!allowedTypes.includes(file.type)) {
   notify("Please select a JPG, PNG or WebP image.");
   event.target.value = "";
   return;
  }

  if (file.size > 10 * 1024 * 1024) {
   notify("Image must be 10 MB or smaller.");
   event.target.value = "";
   return;
  }

  setImageFile(file);
  setGenerated(null);
 }

 function removeImage() {
  setImageFile(null);

  const fileInput = document.getElementById(
      "chain-image-input"
  ) as HTMLInputElement | null;

  if (fileInput) fileInput.value = "";
 }

 async function execute() {
  if (!active) return;

  if (!input.trim() && !imageFile) {
   notify("Enter some text or upload an image first.");
   return;
  }

  setBusy(true);
  setGenerated(null);

  try {
   let image: ImagePayload | undefined;

   if (imageFile) {
    image = await fileToBase64(imageFile);
   }

   // Run the chain with the original text and optional image.
   const result = await api(
       `/api/chains/${selected}/execute`,
       "POST",
       {
        input,
        image,
       }
   );

   if (!result.image?.data || !result.image?.mimeType) {
    throw new Error(
        "The chain completed, but no generated image was returned."
    );
   }

   // Save the generated image using the existing media API.
   const saved = await api("/api/media", "POST", {
    chain_id: selected,
    prompt: result.finalPrompt,
    base64: result.image.data,
    mimeType: result.image.mimeType,
   });

   setGenerated({
    url: saved.url,
    prompt: result.finalPrompt,
    outputs: result.outputs || [],
   });

   await loadMedia();
   notify("Chain completed. Media generated and saved.");
  } catch (error) {
   notify((error as Error).message);
  } finally {
   setBusy(false);
  }
 }

 async function logout() {
  await signOut({ callbackUrl: "/login" });
 }

 const mediaWithUrls = useMemo(() => media, [media]);

 const filteredMedia = mediaWithUrls.filter(
     (item) =>
         mediaFilter === "all" ||
         item.chain_id === mediaFilter
 );

 return (
     <main className="app-shell">
      <header className="topbar">
       <div className="brand">
        <div className="brand-mark">N</div>

        <div>
         <div className="brand-title">NYC UNHINGED</div>
         <div className="brand-sub">PROMPT CHAIN STUDIO</div>
        </div>
       </div>

       <div className="top-actions">
        <span className="user-email">{email}</span>

        <select
            className="theme-select"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            aria-label="Theme"
        >
         <option value="system">System theme</option>
         <option value="dark">Dark</option>
         <option value="light">Light</option>
        </select>

        <button className="btn btn-quiet" onClick={logout}>
         Sign out
        </button>
       </div>
      </header>

      <section className="welcome">
       <div>
        <div className="eyebrow">
         CREATIVE WORKSPACE / ADMIN
        </div>

        <h1>
         Prompt chains, <em>made simple.</em>
        </h1>

        <p>
         Build repeatable creative workflows, run them with
         Gemini, and review the media you generate.
        </p>
       </div>

       <div className="welcome-chip">
        <span className="pulse" /> SUPERADMIN ACCESS
       </div>
      </section>

      {message && <div className="toast">{message}</div>}

      <nav className="tabs">
       <button
           className={tab === "chains" ? "tab active" : "tab"}
           onClick={() => setTab("chains")}
       >
        Prompt chains
       </button>

       <button
           className={tab === "media" ? "tab active" : "tab"}
           onClick={() => {
            setTab("media");
            loadMedia();
           }}
       >
        Generated media
       </button>
      </nav>

      {tab === "chains" ? (
          <div className="workspace">
           <aside className="chain-sidebar">
            <div className="section-head">
             <div>
              <div className="eyebrow">LIBRARY</div>
              <h2>Your chains</h2>
             </div>

             <span className="count-pill">{chains.length}</span>
            </div>

            <button
                className="btn btn-primary full"
                onClick={() => {
                 setEditChain(true);
                 setCreatingChain(true);
                 setChainName("New prompt chain");
                 setChainDescription("");
                }}
            >
             ＋ New chain
            </button>

            <div className="chain-list">
             {chains.map((chain) => (
                 <button
                     key={chain.id}
                     className={`chain-item ${
                         selected === chain.id ? "selected" : ""
                     }`}
                     onClick={() => {
                      setSelected(chain.id);
                      setEditChain(false);
                      setGenerated(null);
                     }}
                 >
                  <span className="chain-dot" />

                  <span className="chain-copy">
                    <b>{chain.name}</b>
                    <small>
                      {chain.description || "No description"}
                    </small>
                  </span>

                  <span
                      className={
                       chain.enabled
                           ? "status-dot"
                           : "status-dot off"
                      }
                  />
                 </button>
             ))}

             {!chains.length && (
                 <p className="muted small-pad">
                  No chains yet. Create your first one.
                 </p>
             )}
            </div>
           </aside>

           <section className="main-panel">
            {creatingChain && (
                <div className="editor-card">
                 <div className="editor-title">
                  Create a prompt chain
                 </div>

                 <input
                     className="field"
                     placeholder="Chain name"
                     value={chainName}
                     onChange={(event) =>
                         setChainName(event.target.value)
                     }
                 />

                 <textarea
                     className="field"
                     placeholder="Description"
                     value={chainDescription}
                     onChange={(event) =>
                         setChainDescription(event.target.value)
                     }
                 />

                 <div className="form-actions">
                  <button
                      className="btn btn-secondary"
                      onClick={() => setCreatingChain(false)}
                  >
                   Cancel
                  </button>

                  <button
                      className="btn btn-primary"
                      disabled={busy || !chainName.trim()}
                      onClick={saveChain}
                  >
                   Create chain
                  </button>
                 </div>
                </div>
            )}

            {active ? (
                <>
                 <div className="panel-heading">
                  <div>
                   <div className="eyebrow">PROMPT CHAIN</div>
                   <h2>{active.name}</h2>
                   <p className="muted">
                    {active.description ||
                        "Add a description to explain what this chain does."}
                   </p>
                  </div>

                  <div className="heading-actions">
                   <button
                       className="btn btn-secondary"
                       onClick={toggleChain}
                   >
                    {active.enabled ? "Disable" : "Enable"}
                   </button>

                   <button
                       className="btn btn-secondary"
                       onClick={startEditChain}
                   >
                    Edit
                   </button>

                   <button
                       className="btn btn-danger"
                       onClick={deleteChain}
                   >
                    Delete
                   </button>
                  </div>
                 </div>

                 {editChain && !creatingChain && (
                     <div className="editor-card">
                      <div className="editor-title">
                       Edit chain details
                      </div>

                      <input
                          className="field"
                          placeholder="Chain name"
                          value={chainName}
                          onChange={(event) =>
                              setChainName(event.target.value)
                          }
                      />

                      <textarea
                          className="field"
                          placeholder="Description"
                          value={chainDescription}
                          onChange={(event) =>
                              setChainDescription(event.target.value)
                          }
                      />

                      <div className="form-actions">
                       <button
                           className="btn btn-secondary"
                           onClick={() => {
                            setEditChain(false);
                            setCreatingChain(false);
                           }}
                       >
                        Cancel
                       </button>

                       <button
                           className="btn btn-primary"
                           disabled={busy}
                           onClick={saveChain}
                       >
                        Save chain
                       </button>
                      </div>
                     </div>
                 )}

                 <div className="steps-head">
                  <div>
                   <div className="eyebrow">WORKFLOW</div>
                   <h3>
                    Chain steps{" "}
                    <span className="muted">
                        ({steps.length})
                      </span>
                   </h3>
                  </div>

                  <span className="hint">
                    Use {"{{input}}"} and{" "}
                   {"{{previous_output}}"} in templates
                  </span>
                 </div>

                 <div className="step-list">
                  {steps.map((step, index) => (
                      <article
                          className="step-card"
                          key={step.id}
                      >
                       <div className="step-number">
                        {String(index + 1).padStart(2, "0")}
                       </div>

                       <div className="step-content">
                        <div className="step-title-row">
                         <h4>{step.name}</h4>

                         <span
                             className={
                              step.enabled
                                  ? "enabled-tag"
                                  : "disabled-tag"
                             }
                         >
                            {step.enabled ? "Enabled" : "Disabled"}
                          </span>
                        </div>

                        <p>{step.prompt_template}</p>
                       </div>

                       <div className="step-actions">
                        <button
                            title="Move up"
                            disabled={index === 0}
                            onClick={() => moveStep(index, -1)}
                        >
                         ↑
                        </button>

                        <button
                            title="Move down"
                            disabled={index === steps.length - 1}
                            onClick={() => moveStep(index, 1)}
                        >
                         ↓
                        </button>

                        <button
                            title={
                             step.enabled
                                 ? "Disable step"
                                 : "Enable step"
                            }
                            onClick={() => toggleStep(step)}
                        >
                         {step.enabled ? "●" : "○"}
                        </button>

                        <button
                            title="Edit"
                            onClick={() => editExistingStep(step)}
                        >
                         ✎
                        </button>

                        <button
                            title="Delete"
                            onClick={() => deleteStep(step.id)}
                        >
                         ×
                        </button>
                       </div>
                      </article>
                  ))}

                  {!steps.length && (
                      <div className="empty-state">
                       <div className="empty-icon">✳</div>
                       <b>This chain is empty</b>
                       <span>
                        Add a step to define what Gemini should do.
                      </span>
                      </div>
                  )}
                 </div>

                 <div className="editor-card">
                  <div className="editor-title">
                   {editStep ? "Edit step" : "Add a step"}
                  </div>

                  <input
                      className="field"
                      placeholder="Step name (e.g. Develop concept)"
                      value={stepName}
                      onChange={(event) =>
                          setStepName(event.target.value)
                      }
                  />

                  <textarea
                      className="field prompt-field"
                      placeholder={
                       "Write the instruction for Gemini...\n\nExample: Turn {{input}} into a concise creative brief."
                      }
                      value={template}
                      onChange={(event) =>
                          setTemplate(event.target.value)
                      }
                  />

                  <div className="form-actions">
                   {editStep && (
                       <button
                           className="btn btn-secondary"
                           onClick={() => {
                            setEditStep("");
                            setStepName("");
                            setTemplate("");
                           }}
                       >
                        Cancel edit
                       </button>
                   )}

                   <button
                       className="btn btn-primary"
                       disabled={
                           busy ||
                           !stepName.trim() ||
                           !template.trim()
                       }
                       onClick={saveStep}
                   >
                    {editStep ? "Update step" : "＋ Add step"}
                   </button>
                  </div>
                 </div>

                 <div className="run-card">
                  <div className="run-heading">
                   <div>
                    <div className="eyebrow">
                     GEMINI EXECUTION
                    </div>

                    <h3>Run this chain</h3>

                    <p className="muted">
                     Upload an image or enter text. Enabled
                     steps execute sequentially, and the final
                     output is used to generate an image.
                    </p>
                   </div>

                   <span className="gemini-mark">
                      ✦ Gemini
                    </span>
                  </div>

                  <label
                      htmlFor="chain-image-input"
                      className="field"
                      style={{
                       display: "block",
                       cursor: "pointer",
                       padding: "14px",
                      }}
                  >
                   <strong>Upload an image (optional)</strong>
                   <span
                       style={{
                        display: "block",
                        fontSize: "0.85rem",
                        opacity: 0.7,
                        marginTop: "5px",
                       }}
                   >
                      JPG, PNG or WebP · Maximum 10 MB
                    </span>
                  </label>

                  <input
                      id="chain-image-input"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleImageChange}
                      disabled={busy}
                      style={{
                       display: "block",
                       marginBottom: "12px",
                       maxWidth: "100%",
                      }}
                  />

                  {imagePreview && (
                      <div
                          style={{
                           marginBottom: "14px",
                           display: "flex",
                           alignItems: "flex-start",
                           gap: "12px",
                           flexWrap: "wrap",
                          }}
                      >
                       <img
                           src={imagePreview}
                           alt="Selected upload preview"
                           style={{
                            width: "160px",
                            height: "140px",
                            objectFit: "cover",
                            borderRadius: "10px",
                           }}
                       />

                       <div>
                        <p style={{ margin: "0 0 8px" }}>
                         {imageFile?.name}
                        </p>

                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={removeImage}
                            disabled={busy}
                        >
                         Remove image
                        </button>
                       </div>
                      </div>
                  )}

                  <textarea
                      className="field"
                      placeholder="Optional text instructions or context..."
                      value={input}
                      onChange={(event) =>
                          setInput(event.target.value)
                      }
                      disabled={busy}
                  />

                  <button
                      className="btn btn-run"
                      disabled={
                          busy ||
                          !steps.some((step) => step.enabled) ||
                          (!input.trim() && !imageFile)
                      }
                      onClick={execute}
                  >
                   {busy
                       ? "Running chain…"
                       : "✦ Run chain and generate media"}
                  </button>

                  {generated && (
                      <div className="generated-result">
                       <img
                           src={generated.url}
                           alt="Generated result"
                       />

                       <div>
                        <b>Generated successfully</b>
                        <p>{generated.prompt}</p>
                       </div>
                      </div>
                  )}

                  {generated?.outputs?.length ? (
                      <div
                          style={{
                           marginTop: "22px",
                           display: "grid",
                           gap: "14px",
                          }}
                      >
                       <h3>Step-by-step results</h3>

                       {generated.outputs.map((item, index) => (
                           <article
                               key={`${index}-${item.step}`}
                               className="step-card"
                               style={{
                                display: "block",
                                padding: "16px",
                               }}
                           >
                            <div className="step-title-row">
                             <h4>
                              Step {index + 1}: {item.step}
                             </h4>
                            </div>

                            <p
                                style={{
                                 whiteSpace: "pre-wrap",
                                 overflowWrap: "anywhere",
                                }}
                            >
                             {item.output}
                            </p>
                           </article>
                       ))}
                      </div>
                  ) : null}
                 </div>
                </>
            ) : (
                <div className="empty-state large">
                 <div className="empty-icon">✳</div>
                 <b>Select or create a prompt chain</b>
                 <span>
                  Your creative workflows will appear here.
                </span>
                </div>
            )}
           </section>
          </div>
      ) : (
          <>
           <div className="media-filter-row">
            <label htmlFor="media-filter">Filter by chain</label>

            <select
                id="media-filter"
                className="theme-select"
                value={mediaFilter}
                onChange={(event) =>
                    setMediaFilter(event.target.value)
                }
            >
             <option value="all">All chains</option>

             {chains.map((chain) => (
                 <option key={chain.id} value={chain.id}>
                  {chain.name}
                 </option>
             ))}
            </select>
           </div>

           <section className="media-grid">
            {filteredMedia.map((item) => (
                <MediaCard key={item.id} item={item} />
            ))}

            {!filteredMedia.length && (
                <div className="empty-state large">
                 <div className="empty-icon">▧</div>
                 <b>No generated media yet</b>
                 <span>
                  Run a prompt chain to see your creations here.
                </span>
                </div>
            )}
           </section>
          </>
      )}

      <footer className="footer">
       <span>NYC UNHINGED · PROMPT CHAIN TOOL</span>
       <span>Built for creative operations</span>
      </footer>
     </main>
 );
}

function MediaCard({
                    item,
                   }: {
 item: Media;
}) {
 const url = item.url || "";

 return (
     <article className="media-card">
      {url ? (
          <img src={url} alt="Generated media" />
      ) : (
          <div className="media-placeholder">
           Loading preview…
          </div>
      )}

      <div className="media-meta">
       <b>
        {item.prompt.slice(0, 95)}
        {item.prompt.length > 95 ? "…" : ""}
       </b>

       <small>
        {new Date(item.created_at).toLocaleString()}
       </small>
      </div>
     </article>
 );
}