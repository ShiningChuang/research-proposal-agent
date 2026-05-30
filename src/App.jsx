import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileText,
  ListChecks,
  Loader2,
  Paperclip,
  Play,
  RefreshCw,
  Sparkles,
  X
} from 'lucide-react';

const DEFAULT_REQUIREMENTS = `Proposal must include:
- Project title
- Abstract
- Motivation and gap
- Project goal
- Method or agent workflow
- Figure or diagram with caption
- Expected results
- Research milestones with timeline estimates
- Evaluation plan
- Risks and mitigation
- Resources or budget
- References, assumptions, or source notes`;

const EMPTY_PROJECT = {
  title: '',
  topic: '',
  problem: '',
  method: '',
  timeline: '',
  evaluation: '',
  resources: '',
  references: '',
  requirements: DEFAULT_REQUIREMENTS
};

const PROJECT_FIELDS = [
  ['problem', 'Problem'],
  ['method', 'Method'],
  ['evaluation', 'Evaluation'],
  ['timeline', 'Timeline'],
  ['resources', 'Resources'],
  ['references', 'Sources']
];

const STAGES = [
  ['1', 'Extract', 'LLM turns the rough idea into structured proposal data'],
  ['2', 'Decide', 'You choose or edit candidate framings'],
  ['3', 'Assemble', 'Accepted fields become project state'],
  ['4', 'Draft', 'LLM writes proposal artifacts'],
  ['5', 'Review', 'Matrix and critique check weak spots']
];

const TABS = [
  ['pdf', FileText, 'PDF'],
  ['latex', FileText, 'LaTeX'],
  ['matrix', ClipboardCheck, 'Matrix'],
  ['evaluation', ListChecks, 'Review']
];

const MEMORY_KEY = 'proposal-agent-final-project-memory-v1';

function App() {
  const [topicInput, setTopicInput] = useState('');
  const [provider, setProvider] = useState(() => localStorage.getItem('proposal-agent-provider') || 'gemini');
  const [providerInfo, setProviderInfo] = useState({ gemini: true, openrouter: true });
  const [papers, setPapers] = useState([]);
  const [relatedWork, setRelatedWork] = useState(null);
  const [relatedStatus, setRelatedStatus] = useState('idle');
  const [fieldAdvice, setFieldAdvice] = useState({});
  const [regenField, setRegenField] = useState('');
  const [project, setProject] = useState(EMPTY_PROJECT);
  const [fieldSuggestions, setFieldSuggestions] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [answeredDecisions, setAnsweredDecisions] = useState({});
  const [otherDrafts, setOtherDrafts] = useState({});
  const [questions, setQuestions] = useState([]);
  const [result, setResult] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [runLog, setRunLog] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('pdf');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [decisionIndex, setDecisionIndex] = useState(0);
  const [memorySavedAt, setMemorySavedAt] = useState('');
  const [memoryReady, setMemoryReady] = useState(false);

  const matrixStats = useMemo(() => {
    const rows = result?.complianceMatrix || [];
    const covered = rows.filter((row) => /^covered$/i.test(row.status)).length;
    return { covered, total: rows.length };
  }, [result]);

  const acceptedCount = PROJECT_FIELDS.filter(([field]) => Boolean(project[field])).length;
  const acceptedSuggestionCount = fieldSuggestions.filter((suggestion) => project[suggestion.field] === suggestion.value).length;
  const currentSuggestion = fieldSuggestions[suggestionIndex] || null;
  const currentDecision = decisions[decisionIndex] || null;
  const sessionActive = Boolean(fieldSuggestions.length || decisions.length || result);
  const providerLocked = sessionActive || status !== 'idle';

  useEffect(() => {
    loadSavedMemory({ silent: true });
    setMemoryReady(true);

    fetch('/api/health')
      .then((response) => response.json())
      .then((data) => {
        if (data?.providers) setProviderInfo(data.providers);
      })
      .catch(() => {});
  }, []);

  function changeProvider(next) {
    if (providerLocked) return;
    setProvider(next);
    localStorage.setItem('proposal-agent-provider', next);
  }

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!memoryReady) return;

    if (!topicInput && !fieldSuggestions.length && !decisions.length && !result) {
      return;
    }

    saveMemory({ silent: true });
  }, [
    memoryReady,
    topicInput,
    project,
    fieldSuggestions,
    decisions,
    questions,
    result,
    runLog,
    activeTab,
    suggestionIndex,
    decisionIndex
  ]);

  async function startAgent() {
    return startAgentForTopic(topicInput);
  }

  async function startSampleAgent() {
    const sampleTopic = 'Citation-grounded agent for literature review workflows';
    setTopicInput(sampleTopic);
    return startAgentForTopic(sampleTopic);
  }

  async function startAgentForTopic(nextTopic) {
    setStatus('starting');
    setError('');
    clearArtifacts();

    const attachments = papers.map((paper) => ({
      name: paper.name,
      mimeType: paper.mimeType,
      data: paper.data
    }));

    // Kick off real related-work retrieval in parallel; it does not block Extract.
    fetchRelatedWork(nextTopic, attachments);

    try {
      const data = await postJson('/api/agent/start', {
        topic: nextTopic,
        requirements: DEFAULT_REQUIREMENTS,
        attachments,
        provider
      });

      setProject({ ...EMPTY_PROJECT, ...data.project });
      setFieldSuggestions(data.fieldSuggestions || []);
      // Decisions are NOT generated from the rough idea. They come later, after the
      // project state is defined, via "Generate Questions".
      setDecisions([]);
      setQuestions([]);
      setAnsweredDecisions({});
      setOtherDrafts({});
      setSuggestionIndex(0);
      setDecisionIndex(0);
      setRunLog([
        logEntry('Extract', data.runMessage || 'LLM prepared structured suggestions.'),
        logEntry('Decide', `Review and accept ${(data.fieldSuggestions || []).length} suggested field(s), then Generate Questions.`)
      ]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  async function fetchRelatedWork(idea, attachments) {
    if (!String(idea || '').trim()) return;

    setRelatedStatus('loading');
    setRelatedWork(null);

    try {
      const data = await postJson('/api/related-work', {
        topic: idea,
        project,
        attachments: attachments || [],
        provider
      });
      setRelatedWork(data);
    } catch (requestError) {
      setRelatedWork({ top: [], error: readError(requestError) });
    } finally {
      setRelatedStatus('idle');
    }
  }

  async function handlePaperUpload(event) {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selected.length) return;

    const room = Math.max(0, 5 - papers.length);
    if (room === 0) {
      setError('You can attach at most 5 papers.');
      return;
    }

    const accepted = [];
    for (const file of selected.slice(0, room)) {
      if (file.type !== 'application/pdf') {
        setError(`Skipped ${file.name}: only PDF files are supported.`);
        continue;
      }
      try {
        accepted.push({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          data: await readFileAsBase64(file)
        });
      } catch {
        setError(`Could not read ${file.name}.`);
      }
    }

    if (accepted.length) {
      setPapers((current) => [...current, ...accepted].slice(0, 5));
    }
  }

  function removePaper(name) {
    setPapers((current) => current.filter((paper) => paper.name !== name));
  }

  async function generateProposal() {
    setStatus('drafting');
    setError('');

    try {
      const data = await postJson('/api/proposal', {
        ...project,
        topic: project.topic || project.title,
        requirements: DEFAULT_REQUIREMENTS,
        provider
      });
      const nextPdfUrl = await exportPdfUrl(data.proposalLatex, project.title || 'proposal');

      setResult(data);
      updatePdfUrl(nextPdfUrl);
      setActiveTab('pdf');
      setRunLog((current) => [
        ...current,
        logEntry('Draft', `Generated proposal using ${data.mode}.`),
        logEntry('Review', `Coverage ${countCovered(data.complianceMatrix)}/${data.complianceMatrix?.length || 0}.`)
      ]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  async function submitFieldSuggestion(suggestion) {
    const advice = (fieldAdvice[suggestion.field] || '').trim();
    if (!advice || regenField) return;

    setRegenField(suggestion.field);
    setError('');

    try {
      const data = await postJson('/api/agent/field', {
        field: suggestion.field,
        project,
        suggestion: advice,
        requirements: DEFAULT_REQUIREMENTS,
        provider
      });

      setFieldSuggestions((current) =>
        current.map((item) =>
          item.field === suggestion.field
            ? {
                ...item,
                value: data.value,
                confidence: data.confidence || item.confidence,
                reason: data.reason || item.reason
              }
            : item
        )
      );
      setFieldAdvice((current) => ({ ...current, [suggestion.field]: '' }));
      setRunLog((current) => [
        ...current,
        logEntry('Refine', `Regenerated ${suggestion.label || suggestion.field} from your suggestion.`)
      ]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setRegenField('');
    }
  }

  function acceptSuggestion(suggestion) {
    updateProjectField(suggestion.field, suggestion.value);
    advanceSuggestion();
    setRunLog((current) => [...current, logEntry('Accept', `Accepted ${suggestion.label || suggestion.field}.`)]);
  }

  function skipSuggestion() {
    if (!currentSuggestion) return;
    advanceSuggestion();
    setRunLog((current) => [...current, logEntry('Skip', `Skipped ${currentSuggestion.label || currentSuggestion.field}.`)]);
  }

  function advanceSuggestion() {
    setSuggestionIndex((current) => Math.min(current + 1, Math.max(fieldSuggestions.length - 1, 0)));
  }

  async function generateQuestions() {
    setStatus('questioning');
    setError('');

    try {
      const data = await postJson('/api/agent/questions', {
        project,
        requirements: DEFAULT_REQUIREMENTS,
        provider
      });
      const nextDecisions = data.decisions || [];
      setDecisions(nextDecisions);
      setDecisionIndex(0);
      setAnsweredDecisions({});
      setOtherDrafts({});
      setRunLog((current) => [
        ...current,
        logEntry('Questions', `Generated ${nextDecisions.length} open question(s) from the project state.`)
      ]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  function chooseOption(decision, option) {
    updateProjectField(decision.field, option.value);
    setAnsweredDecisions((current) => ({ ...current, [decision.id]: option.label }));
    setRunLog((current) => [...current, logEntry('Decision', `Selected ${option.label} for ${decision.title}.`)]);
    advanceDecision();
  }

  function chooseOther(decision) {
    const text = (otherDrafts[decision.id] || '').trim();
    if (!text) return;
    updateProjectField(decision.field, text);
    setAnsweredDecisions((current) => ({ ...current, [decision.id]: 'Other' }));
    setRunLog((current) => [...current, logEntry('Decision', `Custom answer for ${decision.title}.`)]);
    advanceDecision();
  }

  function skipDecision() {
    if (!currentDecision) return;
    advanceDecision();
    setRunLog((current) => [...current, logEntry('Skip', `Skipped ${currentDecision.title}.`)]);
  }

  function advanceDecision() {
    setDecisionIndex((current) => Math.min(current + 1, Math.max(decisions.length - 1, 0)));
  }

  function updateProjectField(field, value) {
    setProject((current) => ({
      ...current,
      [field]: value,
      topic: current.topic || current.title || topicInput
    }));
    clearArtifacts();
  }

  function clearArtifacts() {
    setResult(null);
    updatePdfUrl('');
  }

  function updatePdfUrl(nextUrl) {
    setPdfUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      return nextUrl;
    });
  }

  function reset() {
    setTopicInput('');
    setPapers([]);
    setRelatedWork(null);
    setRelatedStatus('idle');
    setFieldAdvice({});
    setRegenField('');
    setProject(EMPTY_PROJECT);
    setFieldSuggestions([]);
    setDecisions([]);
    setAnsweredDecisions({});
    setOtherDrafts({});
    setQuestions([]);
    clearArtifacts();
    setRunLog([]);
    setError('');
    setActiveTab('pdf');
    setSuggestionIndex(0);
    setDecisionIndex(0);
  }

  function downloadLatex() {
    const proposal = result?.proposalLatex || '';
    const blob = new Blob([proposal], { type: 'text/x-tex;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'proposal.tex';
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async function downloadPdf() {
    if (!result?.proposalLatex) return;

    setStatus('exporting');
    setError('');

    try {
      const href = pdfUrl || (await exportPdfUrl(result.proposalLatex, project.title || 'proposal'));
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'proposal.pdf';
      anchor.click();
      if (!pdfUrl) URL.revokeObjectURL(href);
      setRunLog((current) => [...current, logEntry('Export', 'Downloaded proposal.pdf.')]);
    } catch (requestError) {
      setError(readError(requestError));
    } finally {
      setStatus('idle');
    }
  }

  function saveMemory({ silent = false } = {}) {
    const snapshot = {
      savedAt: new Date().toISOString(),
      topicInput,
      project,
      fieldSuggestions,
      decisions,
      questions,
      result: compactResult(result),
      runLog,
      activeTab,
      suggestionIndex,
      decisionIndex
    };

    localStorage.setItem(MEMORY_KEY, JSON.stringify(snapshot));
    setMemorySavedAt(snapshot.savedAt);

    if (!silent) {
      setRunLog((current) => [...current, logEntry('Memory', 'Saved workspace memory.')]);
    }
  }

  async function loadSavedMemory({ silent = false } = {}) {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) {
      if (!silent) setError('No saved memory found.');
      return;
    }

    try {
      const snapshot = JSON.parse(raw);
      setTopicInput(snapshot.topicInput || '');
      setProject({ ...EMPTY_PROJECT, ...(snapshot.project || {}) });
      setFieldSuggestions(Array.isArray(snapshot.fieldSuggestions) ? snapshot.fieldSuggestions : []);
      setDecisions(Array.isArray(snapshot.decisions) ? snapshot.decisions : []);
      setQuestions(Array.isArray(snapshot.questions) ? snapshot.questions : []);
      setResult(snapshot.result || null);
      setRunLog(Array.isArray(snapshot.runLog) ? snapshot.runLog : []);
      setActiveTab(snapshot.activeTab || 'pdf');
      setSuggestionIndex(Number(snapshot.suggestionIndex || 0));
      setDecisionIndex(Number(snapshot.decisionIndex || 0));
      setMemorySavedAt(snapshot.savedAt || '');
      setError('');

      if (snapshot.result?.proposalLatex) {
        try {
          updatePdfUrl(await exportPdfUrl(snapshot.result.proposalLatex, snapshot.project?.title || 'proposal'));
        } catch {
          updatePdfUrl('');
        }
      } else {
        updatePdfUrl('');
      }

      if (!silent) {
        setRunLog((current) => [...current, logEntry('Memory', 'Reloaded saved workspace memory.')]);
      }
    } catch {
      setError('Saved memory is unreadable. Clear it and save again.');
    }
  }

  function clearSavedMemory() {
    localStorage.removeItem(MEMORY_KEY);
    setMemorySavedAt('');
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Research Proposal Agent</h1>
        <div className="provider-switch" role="group" aria-label="Model provider">
          <button
            type="button"
            className={provider === 'gemini' ? 'active' : ''}
            disabled={providerLocked || !providerInfo.gemini}
            onClick={() => changeProvider('gemini')}
            title={providerInfo.gemini ? 'Use Gemini' : 'Gemini not configured in .env'}
          >
            Gemini
          </button>
          <button
            type="button"
            className={provider === 'openrouter' ? 'active' : ''}
            disabled={providerLocked || !providerInfo.openrouter}
            onClick={() => changeProvider('openrouter')}
            title={providerInfo.openrouter ? 'Use OpenRouter' : 'OpenRouter not configured in .env'}
          >
            OpenRouter
          </button>
        </div>
        <span className="status-pill">
          <Sparkles size={16} aria-hidden="true" />
          {result?.mode || (fieldSuggestions.length ? 'structuring' : 'ready')}
        </span>
      </header>
      {providerLocked ? (
        <p className="provider-hint">Model locked to <strong>{provider}</strong> for this session. Press Reset to switch.</p>
      ) : null}

      <section className="workspace single-pane">
        <section className="workflow-artifact">
          <div className="topic-launch">
            <label htmlFor="project-topic">
              Rough Idea
              <input
                id="project-topic"
                value={topicInput}
                onChange={(event) => setTopicInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') startAgent();
                }}
                placeholder="Example: Agent for citation-grounded literature review"
              />
            </label>
            <div className="actions framework-actions">
              <button className="primary" disabled={!topicInput.trim() || status !== 'idle'} onClick={startAgent} type="button">
                {status === 'starting' ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
                Structure Idea
              </button>
              <button className="secondary" disabled={status !== 'idle'} onClick={startSampleAgent} type="button">
                <Sparkles size={18} aria-hidden="true" />
                Sample
              </button>
              <button className="secondary icon-button" onClick={reset} type="button" aria-label="Reset">
                <RefreshCw size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="paper-uploader">
            <div className="paper-uploader-head">
              <div>
                <strong>Reference Papers</strong>
                <span>Optional. Attach up to 5 PDFs you have read to ground retrieval and understanding.</span>
              </div>
              <label className="secondary upload-button">
                <Paperclip size={16} aria-hidden="true" />
                Attach PDF
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  hidden
                  disabled={papers.length >= 5}
                  onChange={handlePaperUpload}
                />
              </label>
            </div>
            {papers.length ? (
              <ul className="paper-chip-list">
                {papers.map((paper) => (
                  <li className="paper-chip" key={paper.name}>
                    <FileText size={14} aria-hidden="true" />
                    <span title={paper.name}>{paper.name}</span>
                    <button type="button" aria-label={`Remove ${paper.name}`} onClick={() => removePaper(paper.name)}>
                      <X size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="memory-bar">
            <div>
              <strong>Memory</strong>
              <span>{memorySavedAt ? `Saved ${formatSavedAt(memorySavedAt)}` : 'No saved workspace yet'}</span>
            </div>
            <div className="memory-actions">
              <button className="secondary" type="button" onClick={() => saveMemory()}>
                Save
              </button>
              <button className="secondary" type="button" onClick={() => loadSavedMemory()}>
                Reload
              </button>
              <button className="secondary" type="button" onClick={clearSavedMemory}>
                Clear
              </button>
            </div>
          </div>

          {error ? <p className="error-banner">{error}</p> : null}


          <div className="workflow-grid" aria-label="Workflow stages">
            {STAGES.map(([number, title, description], index) => (
              <article className="stage-card" key={title}>
                <div className="stage-topline">
                  <span className="stage-number">{number}</span>
                  <span className={`stage-status ${stageStatus(index, fieldSuggestions, decisions, project, result)}`}>
                    {stageLabel(index, fieldSuggestions, decisions, project, result)}
                  </span>
                </div>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>

          <RelatedWorkPanel relatedWork={relatedWork} status={relatedStatus} />

          <div className="workspace-grid">
            <section className="workspace-panel suggestions-panel">
              <PanelHeader title="LLM Suggested Structure" meta={`${fieldSuggestions.length} fields`} />
              {fieldSuggestions.length ? (
                <div className="suggestion-deck">
                  <div className="deck-progress">
                    <span>{Math.min(suggestionIndex + 1, fieldSuggestions.length)} / {fieldSuggestions.length}</span>
                    <strong>{acceptedSuggestionCount} accepted</strong>
                  </div>
                  {currentSuggestion ? (
                    <article className="suggestion-card active-card" key={`${currentSuggestion.field}-${currentSuggestion.value}`}>
                      <div className="card-line">
                        <h3>{currentSuggestion.label || labelForField(currentSuggestion.field)}</h3>
                        <span className={`priority ${String(currentSuggestion.confidence || 'medium').toLowerCase()}`}>
                          {currentSuggestion.confidence || 'Medium'}
                        </span>
                      </div>
                      <p>{currentSuggestion.value}</p>
                      <small>{currentSuggestion.reason}</small>
                      <div className="field-advice">
                        <textarea
                          value={fieldAdvice[currentSuggestion.field] || ''}
                          placeholder={`Suggest how to improve ${currentSuggestion.label || labelForField(currentSuggestion.field)}, then regenerate just this section…`}
                          onChange={(event) =>
                            setFieldAdvice((current) => ({ ...current, [currentSuggestion.field]: event.target.value }))
                          }
                        />
                        <button
                          className="secondary"
                          type="button"
                          disabled={!(fieldAdvice[currentSuggestion.field] || '').trim() || Boolean(regenField)}
                          onClick={() => submitFieldSuggestion(currentSuggestion)}
                        >
                          {regenField === currentSuggestion.field ? (
                            <Loader2 className="spin" size={15} aria-hidden="true" />
                          ) : (
                            <Sparkles size={15} aria-hidden="true" />
                          )}
                          Submit Suggestion
                        </button>
                      </div>
                      <div className="deck-actions">
                        <button
                          className={project[currentSuggestion.field] === currentSuggestion.value ? 'secondary accepted' : 'primary'}
                          type="button"
                          onClick={() => acceptSuggestion(currentSuggestion)}
                        >
                          <CheckCircle2 size={16} aria-hidden="true" />
                          {project[currentSuggestion.field] === currentSuggestion.value ? 'Accepted' : 'Accept and Next'}
                        </button>
                        <button className="secondary" type="button" onClick={skipSuggestion}>
                          Skip
                        </button>
                      </div>
                    </article>
                  ) : null}
                  <div className="deck-nav">
                    <button
                      className="secondary"
                      type="button"
                      disabled={suggestionIndex === 0}
                      onClick={() => setSuggestionIndex((current) => Math.max(current - 1, 0))}
                    >
                      Previous
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={suggestionIndex >= fieldSuggestions.length - 1}
                      onClick={() => setSuggestionIndex((current) => Math.min(current + 1, fieldSuggestions.length - 1))}
                    >
                      Next
                    </button>
                  </div>
                  <div className="deck-strip" aria-label="Suggestion progress">
                    {fieldSuggestions.map((suggestion, index) => (
                      <button
                        key={`${suggestion.field}-${index}`}
                        className={[
                          'deck-dot',
                          index === suggestionIndex ? 'current' : '',
                          project[suggestion.field] === suggestion.value ? 'done' : ''
                        ].join(' ')}
                        type="button"
                        aria-label={`Open ${suggestion.label || labelForField(suggestion.field)}`}
                        onClick={() => setSuggestionIndex(index)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState text="Enter a rough idea, then let the model structure it." compact />
              )}
            </section>

            <section className="workspace-panel state-panel">
              <PanelHeader title="Accepted Project State" meta={`${acceptedCount}/${PROJECT_FIELDS.length} ready`} />
              <label>
                Project Title
                <input value={project.title} onChange={(event) => updateProjectField('title', event.target.value)} />
              </label>
              {PROJECT_FIELDS.map(([field, label]) => (
                <label key={field}>
                  {label}
                  <textarea value={project[field] || ''} onChange={(event) => updateProjectField(field, event.target.value)} />
                </label>
              ))}
              <button className="primary" disabled={!project.title || status !== 'idle'} onClick={generateQuestions} type="button">
                {status === 'questioning' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}
                Generate Questions
              </button>
            </section>
          </div>

          <section className="workspace-panel decisions-panel decisions-row">
            <div className="panel-header">
              <h2>Decision Needed</h2>
              <span>{decisions.length ? `${decisionIndex + 1} / ${decisions.length}` : '0 open'}</span>
            </div>
            {decisions.length ? (
              <div className="decision-deck">
                {currentDecision ? (
                  <article className="decision-card active-card" key={currentDecision.id}>
                    <div className="card-line">
                      <h3>{currentDecision.title}</h3>
                      {answeredDecisions[currentDecision.id] ? (
                        <span className="priority low">Answered: {answeredDecisions[currentDecision.id]}</span>
                      ) : null}
                    </div>
                    <p>{currentDecision.question}</p>
                    <div className="option-tiles">
                      {currentDecision.options.map((option) => (
                        <button
                          className="option-button"
                          key={`${currentDecision.id}-${option.label}`}
                          type="button"
                          onClick={() => chooseOption(currentDecision, option)}
                        >
                          <strong>{option.label}</strong>
                          <span>{option.value}</span>
                          <small>{option.rationale}</small>
                        </button>
                      ))}
                      <div className="option-button other-tile">
                        <strong>Other</strong>
                        <textarea
                          value={otherDrafts[currentDecision.id] || ''}
                          placeholder="Answer in your own words…"
                          onChange={(event) =>
                            setOtherDrafts((current) => ({ ...current, [currentDecision.id]: event.target.value }))
                          }
                        />
                        <button
                          className="secondary"
                          type="button"
                          disabled={!(otherDrafts[currentDecision.id] || '').trim()}
                          onClick={() => chooseOther(currentDecision)}
                        >
                          <CheckCircle2 size={15} aria-hidden="true" /> Use this answer
                        </button>
                      </div>
                    </div>
                    <div className="deck-actions">
                      <button className="secondary" type="button" onClick={skipDecision}>
                        Skip
                      </button>
                    </div>
                  </article>
                ) : null}
                <div className="deck-nav">
                  <button
                    className="secondary"
                    type="button"
                    disabled={decisionIndex === 0}
                    onClick={() => setDecisionIndex((current) => Math.max(current - 1, 0))}
                  >
                    Previous
                  </button>
                  {decisionIndex >= decisions.length - 1 ? (
                    <button className="primary" type="button" disabled={status !== 'idle'} onClick={generateProposal}>
                      {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                      Generate Proposal
                    </button>
                  ) : (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setDecisionIndex((current) => Math.min(current + 1, decisions.length - 1))}
                    >
                      Next
                    </button>
                  )}
                </div>
                <div className="deck-strip" aria-label="Decision progress">
                  {decisions.map((decision, index) => (
                    <button
                      key={`${decision.id}-${index}`}
                      className={[
                        'deck-dot',
                        index === decisionIndex ? 'current' : '',
                        answeredDecisions[decision.id] ? 'done' : ''
                      ].join(' ')}
                      type="button"
                      aria-label={`Open ${decision.title}`}
                      onClick={() => setDecisionIndex(index)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="decisions-empty">
                <EmptyState
                  text="Accept your field suggestions first, then click Generate Questions to get open questions here."
                  compact
                />
                {project.title ? (
                  <button className="secondary" type="button" disabled={status !== 'idle'} onClick={generateProposal}>
                    {status === 'drafting' ? <Loader2 className="spin" size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                    Skip questions, generate proposal
                  </button>
                ) : null}
              </div>
            )}
          </section>

          <div className="workflow-columns">
            <section className="workflow-panel">
              <h2>Run Log</h2>
              {runLog.length ? (
                <ol className="run-log">
                  {runLog.map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.stage}</span>
                      <p>{entry.message}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState text="Run log appears after the idea is structured." compact />
              )}
            </section>

            <section className="workflow-panel artifacts-panel">
              <div className="artifact-toolbar">
                <nav className="tabs" aria-label="Generated artifacts">
                  {TABS.map(([id, Icon, label]) => (
                    <button
                      key={id}
                      className={activeTab === id ? 'tab active' : 'tab'}
                      type="button"
                      onClick={() => setActiveTab(id)}
                    >
                      <Icon size={17} aria-hidden="true" />
                      {label}
                    </button>
                  ))}
                </nav>
                <button className="secondary" type="button" disabled={!result?.proposalLatex} onClick={downloadLatex}>
                  <Download size={17} aria-hidden="true" />
                  LaTeX
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={!result?.proposalLatex || status !== 'idle'}
                  onClick={downloadPdf}
                >
                  {status === 'exporting' ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
                  PDF
                </button>
              </div>

              <div className="artifact-summary">
                <div>
                  <span>Coverage</span>
                  <strong>{matrixStats.total ? `${matrixStats.covered}/${matrixStats.total}` : '0/0'}</strong>
                </div>
                <div>
                  <span>Accepted</span>
                  <strong>{acceptedCount}/{PROJECT_FIELDS.length}</strong>
                </div>
                <div>
                  <span>Provider</span>
                  <strong>{result?.provider || 'waiting'}</strong>
                </div>
              </div>

              {renderArtifact(activeTab, result, pdfUrl)}
            </section>
          </div>
        </section>
      </section>
    </main>
  );
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || data.error || 'Request failed.');
  }

  return data;
}

async function exportPdfUrl(proposalLatex, title) {
  const response = await fetch('/api/export/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      proposalLatex
    })
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.detail || data.error || 'PDF export failed.');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function renderArtifact(activeTab, result, pdfUrl) {
  if (!result) {
    return <EmptyState text="Proposal artifacts appear after Generate Proposal." />;
  }

  if (activeTab === 'pdf') {
    return pdfUrl ? (
      <iframe className="pdf-preview" src={pdfUrl} title="Compiled proposal PDF" />
    ) : (
      <EmptyState text="PDF preview is rendering." />
    );
  }

  if (activeTab === 'matrix') {
    return (
      <div className="matrix-wrap">
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Status</th>
              <th>Evidence</th>
              <th>Fix</th>
            </tr>
          </thead>
          <tbody>
            {(result.complianceMatrix || []).map((row, index) => (
              <tr key={`${row.requirement}-${index}`}>
                <td>{row.requirement}</td>
                <td>
                  <span className={/^covered$/i.test(row.status) ? 'badge covered' : 'badge needs-work'}>{row.status}</span>
                </td>
                <td>{row.evidence}</td>
                <td>{row.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (activeTab === 'evaluation') {
    return <pre>{result.evaluationReport}</pre>;
  }

  return <pre className="proposal-output">{result.proposalLatex}</pre>;
}

function RelatedWorkPanel({ relatedWork, status }) {
  const papers = relatedWork?.top || [];
  const isLoading = status === 'loading';

  return (
    <section className="related-work">
      <div className="panel-header">
        <h2>
          <BookOpen size={18} aria-hidden="true" /> Related Work (Real Retrieval)
        </h2>
        <span>
          {isLoading
            ? 'Searching arXiv + Semantic Scholar…'
            : relatedWork
              ? `Top ${papers.length} · ${relatedWork.mode || 'ranked'}`
              : 'Runs on Structure Idea'}
        </span>
      </div>

      {isLoading ? (
        <div className="related-loading">
          <Loader2 className="spin" size={20} aria-hidden="true" />
          <p>Retrieving real papers and scoring relevance…</p>
        </div>
      ) : !relatedWork ? (
        <EmptyState text="Click Structure Idea to retrieve real related papers from arXiv and Semantic Scholar." compact />
      ) : papers.length ? (
        <>
          <div className="related-grid">
            {papers.map((paper, index) => (
              <RelatedPaperCard key={`${paper.title}-${index}`} paper={paper} rank={index + 1} />
            ))}
          </div>
          <p className="related-foot">
            Sources — arXiv: {relatedWork.sources?.arxiv || 'n/a'} · Semantic Scholar: {relatedWork.sources?.semanticScholar || 'n/a'}.
            Influence and freshness come from real metadata; relevance is model-scored. Links are real; verify before citing.
          </p>
        </>
      ) : (
        <EmptyState
          text={relatedWork.error
            ? `Retrieval failed: ${relatedWork.error}`
            : 'No papers found. Try a more specific idea or attach reference PDFs.'}
          compact
        />
      )}
    </section>
  );
}

function RelatedPaperCard({ paper, rank }) {
  return (
    <article className="paper-card">
      <div className="paper-card-top">
        <span className="paper-rank">#{rank}</span>
        <span className="paper-overall" title="Combined score">{paper.score}</span>
      </div>
      <h3>
        {paper.url ? (
          <a href={paper.url} target="_blank" rel="noreferrer">
            {paper.title} <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : (
          paper.title
        )}
      </h3>
      <p className="paper-meta">
        {[paper.venue || paper.source, paper.year, paper.citationCount != null ? `${paper.citationCount} cites` : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {paper.rationale ? <p className="paper-rationale">{paper.rationale}</p> : null}
      <div className="paper-scores">
        <ScoreBadge label="Relevance" value={paper.relevance} />
        <ScoreBadge label="Influence" value={paper.influence} />
        <ScoreBadge label="Freshness" value={paper.freshness} />
      </div>
    </article>
  );
}

function ScoreBadge({ label, value }) {
  const tier = value >= 67 ? 'high' : value >= 34 ? 'mid' : 'low';
  return (
    <span className={`score-badge ${tier}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function PanelHeader({ title, meta }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function EmptyState({ text, compact = false }) {
  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      <FileText size={compact ? 24 : 32} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function stageStatus(index, fieldSuggestions, decisions, project, result) {
  if (index === 0 && fieldSuggestions.length) return 'status-complete';
  if (index === 1 && decisions.length) return 'status-complete';
  if (index === 2 && PROJECT_FIELDS.some(([field]) => project[field])) return 'status-complete';
  if (index >= 3 && result) return 'status-complete';
  return 'status-waiting';
}

function stageLabel(index, fieldSuggestions, decisions, project, result) {
  if (index === 0 && fieldSuggestions.length) return 'Shown';
  if (index === 1 && decisions.length) return 'Shown';
  if (index === 2 && PROJECT_FIELDS.some(([field]) => project[field])) return 'Shown';
  if (index >= 3 && result) return 'Shown';
  return 'Ready';
}

function countCovered(rows = []) {
  return rows.filter((row) => /^covered$/i.test(row.status)).length;
}

function labelForField(field) {
  const found = PROJECT_FIELDS.find(([key]) => key === field);
  return found?.[1] || 'Field';
}

function logEntry(stage, message) {
  return {
    id: `${stage}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    stage,
    message
  };
}

function readError(error) {
  return error instanceof Error ? error.message : String(error);
}

function compactResult(result) {
  if (!result) return null;

  return {
    mode: result.mode,
    provider: result.provider,
    proposalLatex: result.proposalLatex,
    complianceMatrix: result.complianceMatrix,
    evaluationReport: result.evaluationReport,
    questions: result.questions
  };
}

function formatSavedAt(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'recently';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default App;
