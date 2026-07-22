'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Archive,
  ArrowUp,
  BookOpen,
  Check,
  Loader2,
  MessageSquareText,
  Search,
  Square,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { StockSearchResult } from '@bourse/shared-types';
import {
  cancelChatGeneration,
  createChatGeneration,
  createChatThread,
  getChatThread,
  listChatThreads,
  listRecentChatThreads,
  searchStocks,
  streamChatGeneration,
  updateChatThread,
  deleteChatThread,
  type AnalysisChatSummaryDto,
  type ChatGenerationDto,
  type ChatMessageDto,
  type ChatSsePayload,
  type ChatThreadDto,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/components/shared/markdown-renderer';
import {
  Button,
  Input,
  InputShell,
  PageHeader,
  Select,
  SelectOption,
} from '@/components/ui';

type DisplayMessage = ChatMessageDto & { streaming?: boolean };

const OPEN_SUGGESTIONS = [
  '最近有哪些值得核对的重要事件？',
  '这家公司的核心收入来源是什么？',
  '自由现金流和净利润有什么区别？',
];

export default function ChatPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const symbol = searchParams.get('stock')?.toUpperCase() ?? '';
  const market = searchParams.get('market') ?? 'US';
  const requestedThreadId = searchParams.get('thread') ?? '';
  const requestedAnalysisId = searchParams.get('analysis') ?? '';
  const requestedSection = searchParams.get('section') ?? '';
  const requestedDraft = searchParams.get('draft') === '1';
  const requestedEarnings = searchParams.get('earnings') === '1';

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [threads, setThreads] = useState<ChatThreadDto[]>([]);
  const [recentThreads, setRecentThreads] = useState<ChatThreadDto[]>([]);
  const [threadFilter, setThreadFilter] = useState('');
  const [thread, setThread] = useState<ChatThreadDto | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [selectedAnalysis, setSelectedAnalysis] = useState(requestedAnalysisId);
  const [sources, setSources] = useState<any[]>([]);
  const [running, setRunning] = useState<ChatGenerationDto | null>(null);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const streamAbort = useRef<AbortController | null>(null);
  const activeGeneration = useRef<string | null>(null);
  const lastSeq = useRef<Record<string, number>>({});
  const searchRequest = useRef(0);

  useEffect(() => {
    setSelectedAnalysis(requestedAnalysisId);
  }, [requestedAnalysisId]);

  useEffect(() => {
    if (requestedEarnings && requestedDraft && symbol && !thread && !draft) {
      setDraft('请基于最新财报速读卡，说明本期最重要的数字变化和仍待核对的地方。');
    }
  }, [draft, requestedDraft, requestedEarnings, symbol, thread]);

  useEffect(() => {
    if (!search.trim()) {
      searchRequest.current += 1;
      setSearchResults([]);
      return;
    }
    const requestId = ++searchRequest.current;
    const timer = setTimeout(() => {
      searchStocks(search.trim())
        .then((rows) => {
          if (requestId === searchRequest.current) setSearchResults(rows);
        })
        .catch(() => {
          if (requestId === searchRequest.current) setSearchResults([]);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (symbol) return;
    listRecentChatThreads().then(setRecentThreads).catch(() => setRecentThreads([]));
  }, [symbol]);

  const loadThreads = useCallback(async () => {
    if (!symbol) return;
    try {
      const rows = await listChatThreads(symbol);
      setThreads(rows);
      const target = requestedThreadId
        ? rows.find((row) => row.id === requestedThreadId)
        : requestedDraft
          ? undefined
          : rows[0];
      if (target) {
        const full = await getChatThread(target.id);
        setThread(full);
        setMessages((local) => mergeMessages(full.messages ?? [], local, activeGeneration.current));
        const sourceGeneration = full.generations?.find((generation) =>
          generation.openResearchSnapshot || (generation.groundedSources?.length ?? 0) > 0,
        );
        setSources(sourceGeneration?.openResearchSnapshot
          ? withSourceIds(sourceGeneration.openResearchSnapshot.sources)
          : withSourceIds(sourceGeneration?.groundedSources ?? [], true));
      } else {
        setThread(null);
        setSources([]);
        if (!activeGeneration.current) setMessages([]);
      }
    } catch {
      setError('研究主题暂时无法加载');
    }
  }, [symbol, requestedDraft, requestedThreadId]);

  useEffect(() => {
    setError('');
    void loadThreads();
  }, [loadThreads]);

  const eligibleAnalyses = thread?.eligibleAnalyses ?? [];
  const activeAnalysis = eligibleAnalyses.find((item) => item.id === selectedAnalysis);
  const isOpenResearch = !selectedAnalysis;

  const selectStock = (result: StockSearchResult) => {
    const nextSymbol = result.yahooSymbol || result.symbol;
    router.push(`/chat?stock=${encodeURIComponent(nextSymbol)}&market=${encodeURIComponent(result.market)}`);
    setSearch('');
    setSearchResults([]);
  };

  const selectThread = (next: ChatThreadDto) => {
    router.push(`/chat?stock=${encodeURIComponent(next.primaryStock.yahooSymbol || next.primaryStock.symbol)}&market=${next.primaryStock.market}&thread=${next.id}`);
  };

  const filteredThreads = threads.filter((item) =>
    item.title.toLowerCase().includes(threadFilter.trim().toLowerCase()),
  );

  const newThreadDraft = () => {
    setThread(null);
    setMessages([]);
    setSources([]);
    setError('');
    const params = new URLSearchParams({ stock: symbol, market, draft: '1' });
    if (selectedAnalysis) {
      params.set('analysis', selectedAnalysis);
      if (requestedSection) params.set('section', requestedSection);
    }
    router.push(`/chat?${params.toString()}`);
  };

  const startRenaming = () => {
    if (!thread) return;
    setRenameTitle(thread.title);
    setRenaming(true);
  };

  const renameCurrentThread = async () => {
    if (!thread) return;
    const title = renameTitle.trim();
    if (!title) return;
    if (title === thread.title) {
      setRenaming(false);
      return;
    }
    const updated = await updateChatThread(thread.id, { title });
    setThread((value) => value ? { ...value, title: updated.title } : value);
    setThreads((items) => items.map((item) => item.id === updated.id ? { ...item, title: updated.title } : item));
    setRenaming(false);
  };

  const archiveCurrentThread = async () => {
    if (!thread) return;
    await updateChatThread(thread.id, { action: 'archive' });
    setThreads((items) => items.filter((item) => item.id !== thread.id));
    newThreadDraft();
  };

  const removeCurrentThread = async () => {
    if (!thread || !window.confirm(`删除“${thread.title}”及其 Chat 消息？原 Analysis 不受影响。`)) return;
    await deleteChatThread(thread.id);
    setThreads((items) => items.filter((item) => item.id !== thread.id));
    newThreadDraft();
  };

  const consumeGeneration = useCallback(async (
    generation: ChatGenerationDto,
    assistantMessageId: string,
    controller: AbortController,
  ) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await streamChatGeneration(generation.id, (event: ChatSsePayload) => {
        if (typeof event.seq === 'number') {
          if (event.seq <= (lastSeq.current[generation.id] ?? 0)) return;
          lastSeq.current[generation.id] = event.seq;
        }
        if (event.event === 'research_sources') {
          setSources(withSourceIds(event.sources ?? [], event.mode === 'ANALYSIS_GROUNDED'));
        }
        if (event.event === 'text_block') {
          setMessages((items) => items.map((item) => item.id === assistantMessageId
            ? { ...item, content: item.content + String(event.text ?? '') }
            : item));
        }
        if (event.event === 'text_replace') {
          setMessages((items) => items.map((item) => item.id === assistantMessageId
            ? { ...item, content: String(event.text ?? '') }
            : item));
        }
        if (event.event === 'error') setError('回答服务暂时不可用，可以重试这条问题。');
        if (event.event === 'done') {
          const finishReason = String(event.finishReason ?? 'failed');
          setMessages((items) => items.map((item) => item.id === assistantMessageId
            ? {
                ...item,
                content: item.content || (finishReason === 'cancelled' ? '本轮回答已取消。' : item.content),
                status: finishReason === 'completed' ? 'COMPLETED' : finishReason === 'cancelled' ? 'COMPLETED' : 'FAILED',
                streaming: false,
              }
            : item));
        }
      }, {
        signal: controller.signal,
        afterSeq: lastSeq.current[generation.id] ?? 0,
      });
      if (result.done) return;
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error('Chat 连接中断，自动重连未成功');
  }, []);

  const send = async () => {
    const question = draft.trim();
    if (!question || running || question.length > 800 || !symbol) return;
    setError('');
    setDraft('');
    let activeThread = thread;
    let pendingUrl = '';
    let generationId = '';
    try {
      if (!activeThread) {
        activeThread = await createChatThread(symbol, market);
        setThread(activeThread);
        setThreads((items) => [activeThread!, ...items.filter((item) => item.id !== activeThread!.id)]);
        const params = new URLSearchParams(searchParams.toString());
        params.set('stock', symbol);
        params.set('market', market);
        params.set('thread', activeThread.id);
        params.delete('draft');
        if (selectedAnalysis) {
          params.set('analysis', selectedAnalysis);
        } else {
          params.delete('analysis');
          params.delete('section');
        }
        pendingUrl = `/chat?${params.toString()}`;
      }
      const clientRequestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const generation = await createChatGeneration(activeThread.id, {
        question,
        clientRequestId,
        ...(selectedAnalysis ? { analysisIds: [selectedAnalysis], modeHint: 'ANALYSIS_GROUNDED' as const } : { modeHint: 'OPEN_RESEARCH' as const }),
        ...(selectedAnalysis && requestedSection ? { sectionTypes: [requestedSection] } : {}),
      });
      generationId = generation.id;
      activeGeneration.current = generation.id;
      setRunning(generation);
      const now = new Date().toISOString();
      const userMessage: DisplayMessage = {
        id: `local-user-${generation.id}`,
        generationId: generation.id,
        role: 'USER',
        kind: 'TEXT',
        status: 'COMPLETED',
        content: question,
        sequence: (messages.at(-1)?.sequence ?? 0) + 1,
        createdAt: now,
      };
      const assistantMessage: DisplayMessage = {
        id: `local-assistant-${generation.id}`,
        generationId: generation.id,
        role: 'ASSISTANT',
        kind: 'TEXT',
        status: 'PARTIAL',
        content: '',
        sequence: userMessage.sequence + 1,
        createdAt: now,
        streaming: true,
      };
      setMessages((items) => [...items, userMessage, assistantMessage]);
      if (pendingUrl) router.replace(pendingUrl);
      const controller = new AbortController();
      streamAbort.current = controller;
      await consumeGeneration(generation, assistantMessage.id, controller);
      const full = await getChatThread(activeThread.id);
      setThread(full);
      setMessages(full.messages ?? []);
      const completedGeneration = full.generations?.find((item) => item.id === generation.id);
      setSources((current) => completedGeneration?.openResearchSnapshot
        ? withSourceIds(completedGeneration.openResearchSnapshot.sources)
        : completedGeneration?.groundedSources?.length
          ? withSourceIds(completedGeneration.groundedSources, true)
          : current);
      setThreads((items) => [full, ...items.filter((item) => item.id !== full.id)]);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(err?.message || '发送失败');
    } finally {
      streamAbort.current = null;
      if (activeGeneration.current === generationId) activeGeneration.current = null;
      setRunning(null);
    }
  };

  const stop = async () => {
    if (!running) return;
    streamAbort.current?.abort();
    await cancelChatGeneration(running.id).catch(() => undefined);
    if (thread) {
      const full = await getChatThread(thread.id).catch(() => null);
      if (full) {
        setThread(full);
        setMessages(full.messages ?? []);
      }
    }
    setRunning(null);
  };

  useEffect(() => {
    const resumable = thread?.generations?.find((generation) =>
      generation.status === 'PENDING' || generation.status === 'RUNNING',
    );
    if (!thread || !resumable || activeGeneration.current) return;

    const assistantId = `local-assistant-${resumable.id}`;
    activeGeneration.current = resumable.id;
    setRunning(resumable);
    setMessages((items) => {
      if (items.some((item) => item.id === assistantId || (
        item.generationId === resumable.id && item.role === 'ASSISTANT'
      ))) return items;
      return [...items, {
        id: assistantId,
        generationId: resumable.id,
        role: 'ASSISTANT',
        kind: 'TEXT',
        status: 'PARTIAL',
        content: '',
        sequence: (items.at(-1)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        streaming: true,
      }];
    });
    const controller = new AbortController();
    streamAbort.current = controller;
    void consumeGeneration(resumable, assistantId, controller)
      .then(async () => {
        const full = await getChatThread(thread.id);
        setThread(full);
        setMessages(full.messages ?? []);
        const completed = full.generations?.find((item) => item.id === resumable.id);
        setSources((current) => completed?.openResearchSnapshot
          ? withSourceIds(completed.openResearchSnapshot.sources)
          : completed?.groundedSources?.length
            ? withSourceIds(completed.groundedSources, true)
            : current);
      })
      .catch((resumeError: any) => {
        if (resumeError?.name !== 'AbortError') {
          setError(resumeError?.message || '恢复回答失败');
        }
      })
      .finally(() => {
        if (activeGeneration.current === resumable.id) activeGeneration.current = null;
        if (streamAbort.current === controller) streamAbort.current = null;
        setRunning((value) => value?.id === resumable.id ? null : value);
      });

    return () => controller.abort();
  }, [consumeGeneration, thread?.id]);

  if (!symbol) {
    return (
      <div className="mx-auto max-w-[920px]">
        <PageHeader
          tag="研究对话"
          title="选择股票开始研究"
          subtitle="进入一只股票的研究主题，或继续最近的对话。"
          className="mb-8"
        />
        <div className="max-w-[680px]">
          <StockSearchField value={search} onChange={setSearch} results={searchResults} onSelect={selectStock} />
          <div className="mt-3 flex flex-wrap gap-2">
            {['AAPL', 'MSFT', 'NVDA'].map((item) => (
              <Button key={item} type="button" size="sm" onClick={() => setSearch(item)}>
                <span className="font-mono">{item}</span>
              </Button>
            ))}
          </div>
        </div>
        {recentThreads.length > 0 && (
          <section className="mt-12">
            <div className="mb-3 flex items-center justify-between border-b border-[var(--color-border)] pb-3">
              <h2 className="text-[14px] font-medium">最近研究</h2>
              <span className="font-mono text-[11px] text-[var(--color-fg-3)]">{recentThreads.length}</span>
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {recentThreads.slice(0, 8).map((item) => (
                <button key={item.id} type="button" onClick={() => selectThread(item)} className="flex min-h-14 w-full items-center gap-4 rounded-[var(--radius-btn)] px-2 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
                  <span className="w-16 shrink-0 font-mono text-[12px] font-medium text-[var(--color-accent-600)]">{item.primaryStock.yahooSymbol || item.primaryStock.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                  <span className="font-mono text-[11px] text-[var(--color-fg-3)]">{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 lg:-my-4 lg:h-[calc(100vh-6rem)] lg:min-h-[620px]">
      <div className="mb-3 flex min-w-0 items-center gap-2 lg:hidden">
        <Button type="button" size="icon" variant="quiet" aria-label="Chat 首页" title="Chat 首页" onClick={() => router.push('/chat')}>
          <MessageSquareText className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        {threads.length > 0 && (
          <select value={thread?.id ?? ''} onChange={(event) => { const next = threads.find((item) => item.id === event.target.value); if (next) selectThread(next); }} className="h-10 min-w-0 flex-1 rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] px-3 text-[13px]" aria-label="选择研究主题">
            {!thread && <option value="">新研究主题</option>}
            {threads.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        )}
        <Button type="button" size="icon" aria-label="新建研究主题" title="新建研究主题" onClick={newThreadDraft}>
          <Plus className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </div>

      <div className="grid min-h-0 gap-6 lg:h-full lg:grid-cols-[244px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col border-r border-[var(--color-border)] pr-5 lg:flex">
          <Button type="button" variant="quiet" className="mb-3 w-full justify-start" onClick={() => router.push('/chat')}>
            <MessageSquareText className="h-4 w-4" strokeWidth={1.5} />
            Chat 首页
          </Button>
          <StockSearchField value={search} onChange={setSearch} results={searchResults} onSelect={selectStock} compact />
          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-[13px] font-medium">{symbol} 研究主题</h2>
            <Button type="button" size="icon" variant="quiet" aria-label="新建研究主题" title="新建研究主题" onClick={newThreadDraft}>
              <Plus className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
          <InputShell leading={<Search />} sans className="mt-2 h-9 bg-[var(--color-bg-elev)]">
            <Input value={threadFilter} onChange={(event) => setThreadFilter(event.target.value)} placeholder="筛选主题" aria-label="筛选研究主题" />
          </InputShell>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {threads.length === 0 ? (
              <p className="px-2 py-3 text-[12px] leading-5 text-[var(--color-fg-3)]">发送问题后会自动创建主题。</p>
            ) : (
              <div className="space-y-1">
                {filteredThreads.map((item) => (
                  <button key={item.id} type="button" onClick={() => selectThread(item)} className={cn('flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-btn)] px-2.5 py-2 text-left transition-colors', item.id === thread?.id ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]' : 'text-[var(--color-fg-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]')}>
                    <MessageSquareText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px]">{item.title}</span><span className="mt-0.5 block font-mono text-[10px] text-[var(--color-fg-3)]">{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-[620px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] lg:min-h-0" aria-label="股票研究对话">
          <header className="border-b border-[var(--color-border)] px-4 py-3.5 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-3)]">
                <span>{market}</span><span>/</span><span>{symbol}</span>
              </div>
              {renaming && thread ? (
                <div className="flex max-w-full items-center gap-1">
                  <input autoFocus value={renameTitle} onChange={(event) => setRenameTitle(event.target.value.slice(0, 120))} onKeyDown={(event) => { if (event.key === 'Enter') void renameCurrentThread(); if (event.key === 'Escape') setRenaming(false); }} aria-label="研究主题名称" className="h-9 min-w-0 max-w-[320px] rounded-[var(--radius-btn)] border border-[var(--color-fg)] bg-[var(--color-bg)] px-3 text-[14px] outline-none" />
                  <IconButton label="保存名称" onClick={() => void renameCurrentThread()}><Check className="h-3.5 w-3.5" /></IconButton>
                  <IconButton label="取消重命名" onClick={() => setRenaming(false)}><X className="h-3.5 w-3.5" /></IconButton>
                </div>
              ) : (
                <h1 className="truncate text-[17px] font-semibold tracking-normal">{thread?.title || `${symbol} 新研究主题`}</h1>
              )}
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
              <AnalysisPicker analyses={eligibleAnalyses} value={selectedAnalysis} onChange={(id) => {
                setSelectedAnalysis(id);
                const params = new URLSearchParams(searchParams.toString());
                if (id) params.set('analysis', id); else { params.delete('analysis'); params.delete('section'); }
                router.replace(`/chat?${params.toString()}`);
              }} />
              {thread && !renaming && !running && <><IconButton label="重命名研究主题" onClick={startRenaming}><Pencil className="h-3.5 w-3.5" /></IconButton><IconButton label="归档研究主题" onClick={() => void archiveCurrentThread()}><Archive className="h-3.5 w-3.5" /></IconButton><IconButton label="删除研究主题" danger onClick={() => void removeCurrentThread()}><Trash2 className="h-3.5 w-3.5" /></IconButton></>}
            </div>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-accent-600)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />{isOpenResearch ? '自由研究' : '基于 Analysis'}</span>
            <span className="text-[var(--color-fg-3)]">{isOpenResearch ? '非正式研究' : activeAnalysis?.dataAsOf ? `数据截至 ${activeAnalysis.dataAsOf}` : '历史分析'}{requestedSection ? ` · ${requestedSection}` : ''}{activeAnalysis && !activeAnalysis.hasEvidenceSnapshot ? ' · 证据快照不完整' : ''}</span>
          </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
            {error && <div className="mx-auto mb-4 flex max-w-[800px] items-start justify-between gap-3 rounded-[var(--radius-btn)] border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] px-3 py-3 text-[12px] text-[var(--color-danger)]" role="alert"><span>{error}</span><button type="button" aria-label="关闭提示" onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
            {messages.length === 0 ? <Welcome openResearch={isOpenResearch} symbol={symbol} onSuggestion={setDraft} /> : <MessageList messages={messages} />}
            {sources.length > 0 && <SourceList sources={sources} />}
          </div>

          <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 sm:px-5">
            <div className="mx-auto max-w-[800px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-2 transition-colors focus-within:border-[var(--color-fg)]">
              <textarea value={draft} onChange={(event) => setDraft(event.target.value.slice(0, 800))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={Boolean(running)} rows={2} placeholder={isOpenResearch ? `询问 ${symbol} 的公司、行业或财务问题` : '询问这份 Analysis 的结论、数字或来源'} className="min-h-[58px] w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 outline-none placeholder:text-[var(--color-fg-3)] disabled:opacity-60" aria-label="研究问题" />
              <div className="flex items-center justify-between gap-3 px-1">
                <span className="font-mono text-[10px] text-[var(--color-fg-3)]">{draft.length}/800</span>
                {running ? (
                  <Button type="button" size="sm" variant="danger" onClick={() => void stop()}><Square className="h-3.5 w-3.5" />停止</Button>
                ) : (
                  <Button type="button" size="icon" variant="primary" onClick={() => void send()} disabled={!draft.trim() || draft.length > 800} aria-label="发送" title="发送">
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StockSearchField({ value, onChange, results, onSelect, compact = false }: { value: string; onChange: (value: string) => void; results: StockSearchResult[]; onSelect: (result: StockSearchResult) => void; compact?: boolean }) {
  return <div className="relative max-w-[680px]"><InputShell leading={<Search />} sans className={cn('bg-[var(--color-bg-elev)]', compact && 'h-9')}><Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={compact ? '切换股票' : '搜索股票代码或公司名称'} aria-label="搜索股票" /></InputShell>{results.length > 0 && <div className="absolute inset-x-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-bg-elev)]"><div className="max-h-64 overflow-y-auto">{results.slice(0, 8).map((result) => <button key={`${result.market}-${result.symbol}`} type="button" onClick={() => onSelect(result)} className="flex min-h-11 w-full items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2 text-left last:border-0 hover:bg-[var(--color-surface-hover)]"><span className="min-w-0"><span className="font-mono text-[12px]">{result.yahooSymbol || result.symbol}</span><span className="ml-2 truncate text-[12px] text-[var(--color-fg-2)]">{result.name}</span></span><span className="font-mono text-[10px] text-[var(--color-fg-3)]">{result.market}</span></button>)}</div></div>}</div>;
}

function AnalysisPicker({ analyses, value, onChange }: { analyses: AnalysisChatSummaryDto[]; value: string; onChange: (value: string) => void }) {
  const selectedAnalysisIsPending = Boolean(
    value && !analyses.some((analysis) => analysis.id === value),
  );

  return <Select value={value || '__open__'} onValueChange={(next) => onChange(next === '__open__' ? '' : next)} ariaLabel="选择研究上下文" sans className="h-9 max-w-[230px] text-[12px]"><SelectOption value="__open__"><span className="inline-flex items-center gap-2"><BookOpen className="h-3.5 w-3.5" />自由研究</span></SelectOption>{selectedAnalysisIsPending && <SelectOption value={value}>当前 Analysis</SelectOption>}{analyses.map((analysis) => <SelectOption key={analysis.id} value={analysis.id}>{analysis.analysisType} · {analysis.dataAsOf || '无日期'}{analysis.hasEvidenceSnapshot ? '' : ' · 旧证据'}</SelectOption>)}</Select>;
}

function IconButton({ label, danger = false, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" title={label} aria-label={label} onClick={onClick} size="icon" variant={danger ? 'danger' : 'quiet'}>{children}</Button>;
}

function Welcome({ openResearch, symbol, onSuggestion }: { openResearch: boolean; symbol: string; onSuggestion: (value: string) => void }) {
  const suggestions = openResearch ? OPEN_SUGGESTIONS : ['ROE 下降但自由现金流上升意味着什么？', '这份报告最重要的不确定性是什么？', '哪些结论只适用于报告数据日期？'];
  return <div className="mx-auto flex min-h-full max-w-[680px] flex-col justify-center py-8 sm:py-12"><div className="mb-5 flex h-9 w-9 items-center justify-center rounded-[var(--radius-btn)] bg-[var(--color-accent-soft)] text-[var(--color-accent-600)]"><BookOpen className="h-4 w-4" strokeWidth={1.5} /></div><h2 className="text-[20px] font-semibold tracking-normal">{openResearch ? `研究 ${symbol}` : '继续理解这份 Analysis'}</h2><p className="mt-2 max-w-[560px] text-[13px] leading-6 text-[var(--color-fg-2)]">{openResearch ? '从公司事件、业务结构或财务概念开始。' : '选择一个结论、数字或来源继续追问。'}</p><div className="mt-6 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border)]">{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)} className="group flex min-h-12 w-full items-center justify-between gap-3 px-1 text-left text-[13px] text-[var(--color-fg-2)] transition-colors hover:text-[var(--color-fg)]"><span>{suggestion}</span><ArrowUp className="h-3.5 w-3.5 shrink-0 rotate-45 text-[var(--color-fg-3)] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></button>)}</div></div>;
}

function MessageList({ messages }: { messages: DisplayMessage[] }) {
  return <div className="mx-auto max-w-[800px] space-y-6">{messages.map((message) => <article key={message.id} className={cn('flex min-w-0 gap-3', message.role === 'USER' ? 'justify-end' : 'justify-start')}><div className={cn('min-w-0 max-w-[min(700px,92%)]', message.role === 'USER' ? 'rounded-[var(--radius-card)] bg-[var(--color-surface-2)] px-4 py-3' : message.role === 'SYSTEM_NOTICE' ? 'w-full rounded-[var(--radius-btn)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[var(--color-fg-2)]' : 'flex-1')}><div className="mb-1.5 text-[11px] font-medium text-[var(--color-fg-3)]">{message.role === 'USER' ? '你' : message.role === 'SYSTEM_NOTICE' ? '系统' : 'Bourse'}</div>{message.role === 'ASSISTANT' ? <MarkdownRenderer content={message.content} className="text-[14px] leading-7 text-[var(--color-fg)]" /> : <p className="whitespace-pre-wrap text-[14px] leading-6">{message.content}</p>}{message.streaming && <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-fg-3)]"><Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" strokeWidth={1.5} />生成中</div>}</div></article>)}</div>;
}

function SourceList({ sources }: { sources: any[] }) {
  return <details className="mx-auto mt-7 max-w-[800px] border-t border-[var(--color-border)] pt-3"><summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-[var(--radius-btn)] px-1 text-[12px] text-[var(--color-fg-2)] hover:text-[var(--color-fg)]"><Archive className="h-3.5 w-3.5" strokeWidth={1.5} />本轮来源 <span className="font-mono text-[10px] text-[var(--color-fg-3)]">{sources.length}</span></summary><div className="mt-2 divide-y divide-[var(--color-border-soft)]">{sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" className="block rounded-[var(--radius-btn)] px-2 py-3 hover:bg-[var(--color-surface-hover)]"><span className="font-mono text-[10px] text-[var(--color-accent-600)]">{source.id ?? `source-${index}`}</span><span className="ml-2 text-[12px] text-[var(--color-fg)]">{source.title}</span><span className="mt-1 block truncate font-mono text-[10px] text-[var(--color-fg-3)]">{source.url}</span></a>)}</div></details>;
}

function withSourceIds(sources: any[], grounded = false) {
  return sources.map((source, index) => ({
    ...source,
    id: source.id ?? `${grounded ? 'analysis-source' : 'source'}-${index}`,
  }));
}

function mergeMessages(server: ChatMessageDto[], local: DisplayMessage[], activeId: string | null) {
  if (!activeId) return server;
  const activeLocal = local.filter((message) => message.generationId === activeId);
  const persistedKeys = new Set(server.map((message) => `${message.generationId}:${message.role}`));
  return [...server, ...activeLocal.filter((message) => !persistedKeys.has(`${message.generationId}:${message.role}`))]
    .sort((left, right) => left.sequence - right.sequence);
}
