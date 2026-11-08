// Turns one saved conversation (the API's JSON) into the archive's Markdown files. Pure, so the
// archive page and scripts/rerender.mjs (which rebuilds transcripts from conversation.json
// offline, without asking ChatGPT again) produce the same output.
const ArchiveRender = (() => {
  const TOOL_PREVIEW_CHARS = 4000;
  function fence(text, lang = '') {
    const body = String(text ?? '');
    const longest = Math.max(2, ...(body.match(/`+/g) || []).map(m => m.length));
    const ticks = '`'.repeat(longest + 1);
    return `${ticks}${/^[\w+#.-]{1,30}$/.test(lang) && lang !== 'unknown' ? lang : ''}\n${body}\n${ticks}`;
  }
  function clip(text, max = TOOL_PREVIEW_CHARS) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}\n… [${(s.length - max).toLocaleString()} more chars — full text in conversation.json]` : s;
  }
  function mdLink(path) { return `<${path.replace(/>/g, '%3E')}>`; }
  function toIso(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * (value < 1e12 ? 1000 : 1)).toISOString();
    if (typeof value === 'string' && value) return value;
    return '';
  }
  function isoDate(value) { return toIso(value).slice(0, 10) || 'unknown-date'; }
  function isoTime(value) { return toIso(value).replace('T', ' ').slice(0, 16); }
  function messageTree(conv) {
    const mapping = conv.mapping || {};
    const main = [];
    const seen = new Set();
    let id = conv.current_node && mapping[conv.current_node] ? conv.current_node
      : Object.values(mapping).filter(n => n && !n.children?.length).sort((a, b) => (b.message?.create_time || 0) - (a.message?.create_time || 0))[0]?.id;
    for (; id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); main.unshift(mapping[id]); }
    const others = Object.values(mapping).filter(n => n && !seen.has(n.id))
      .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
    return { main: main.filter(n => n.message), others: others.filter(n => n.message) };
  }
  // IDs look like file-AbC… (older chats) or file_0000… (newer). Older asset pointers start with the
  // scheme "file-service://", which must not be mistaken for an ID.
  const FILE_ID = /file[-_](?!service:)[A-Za-z0-9_-]+/;
  function fileIdOf(value) { return String(value || '').replace(/^[a-z][a-z-]*:\/\//i, '').match(FILE_ID)?.[0] || null; }
  function messageText(message) {
    const content = message.content || {};
    if (Array.isArray(content.parts)) return content.parts.filter(p => typeof p === 'string').join('\n');
    return typeof content.text === 'string' ? content.text : typeof content.content === 'string' ? content.content : '';
  }
  function thoughtsText(content) {
    if (Array.isArray(content.thoughts)) {
      return content.thoughts.map(t => [t.summary ? `**${t.summary}**` : '', t.content || ''].filter(Boolean).join('\n\n')).join('\n\n');
    }
    return typeof content.content === 'string' ? content.content : '';
  }
  function renderMessage(node, label, names) {
    const message = node.message;
    const role = message.author?.role || '?';
    const meta = message.metadata || {};
    const content = message.content || {};
    const type = content.content_type;
    const who = role === 'user' ? 'You' : role === 'assistant' ? 'ChatGPT' : role === 'tool' ? `Tool · ${message.author?.name || ''}` : role === 'system' ? 'System' : role;
    const flags = [message.recipient && message.recipient !== 'all' ? `→ ${message.recipient}` : '',
      meta.is_visually_hidden_from_conversation ? 'hidden in ChatGPT' : '', meta.model_slug ? meta.model_slug : ''].filter(Boolean);
    const parts = [`## ${label} · ${who} · ${isoTime(message.create_time)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`];
    let body;
    if (type === 'thoughts') body = `<details><summary>Thinking</summary>\n\n${thoughtsText(content)}\n\n</details>`;
    else if (type === 'reasoning_recap') body = `*${content.content || 'Reasoning'}*`;
    else if (type === 'user_editable_context' || type === 'model_editable_context') {
      body = `<details><summary>${type === 'user_editable_context' ? 'Custom instructions / profile' : 'Memory context'}</summary>\n\n${fence(JSON.stringify(content, null, 2), 'json')}\n\n</details>`;
    } else if (message.recipient && message.recipient !== 'all') {
      body = fence(messageText(message) || JSON.stringify(content, null, 2), content.language || (type === 'code' ? '' : 'json'));
    } else if (role === 'tool' && !['multimodal_text', 'execution_output'].includes(type)) {
      const text = messageText(message) || Transcript.body(message, names);
      body = fence(clip(text));
    } else if (role === 'assistant' && type === 'text' && !/<[A-Za-z][\w:-]*[\s>/]/.test(messageText(message))) {
      // Plain replies verbatim (citations become links). Replies with widget markup use the
      // fallback Markdown ChatGPT stores for them, via Transcript.body.
      body = Transcript.citations(messageText(message), meta);
    } else {
      body = Transcript.body(message, names);
      if (/^\[Unsupported content/.test(body)) body = fence(clip(JSON.stringify(content, null, 2)), 'json');
    }
    if (body && body.trim()) parts.push(body);
    const linked = new Set((meta.attachments || []).map(item => fileIdOf(item.id)));
    const extra = [...new Set((JSON.stringify(message).match(new RegExp(FILE_ID, 'g')) || []).filter(id => id !== 'file-service'))]
      .filter(id => names.has(id) && !linked.has(id) && !parts.join('').includes(names.get(id)));
    if (extra.length) parts.push(extra.map(id => `📎 [${names.get(id).split('/').pop()}](${mdLink(names.get(id))})`).join('\n'));
    for (const item of meta.attachments || []) {
      const saved = names.get(fileIdOf(item.id));
      parts.push(`📎 ${saved ? `[${item.name || 'attachment'}](${mdLink(saved)})` : `${item.name || item.id} (not downloadable)`}`);
    }
    return parts.join('\n\n');
  }

  // transcript.md, chatgpt-view.md, branches.md and thinking.md for one chat (null when empty).
  // chat: { id, title, project, is_archived }; names: file id → path saved inside the chat folder.
  function documents(conv, chat, names) {
    const { main, others } = messageTree(conv);
    const docs = { 'transcript.md': null, 'chatgpt-view.md': null, 'branches.md': null, 'thinking.md': null, thinkingBlocks: 0, viewError: null };
    const title = conv.title || chat.title || 'Untitled';
    const model = conv.default_model_slug || main.findLast(n => n.message.metadata?.model_slug)?.message.metadata.model_slug;
    const header = [`# ${title}`, '', `- Link: https://chatgpt.com/c/${chat.id}`,
      `- Created: ${isoTime(conv.create_time)} · Updated: ${isoTime(conv.update_time)}`,
      model ? `- Model: ${model}` : null, chat.project ? `- Project: ${chat.project}` : null,
      chat.is_archived ? '- Archived in ChatGPT' : null,
      '- Folders: uploads/ (yours), outputs/ (made by ChatGPT), files/ (listed for this chat but not linked from any message — often carried over from the chat it was branched from)',
      `- Messages: ${main.length} on the main thread${others.length ? `, ${others.length} on other branches (see branches.md)` : ''}`, '']
      .filter(line => line !== null).join('\n');
    const transcript = main.map((node, i) => renderMessage(node, String(i + 1), names)).join('\n\n---\n\n');
    docs['transcript.md'] = `${header}\n${transcript}\n`;
    try {
      docs['chatgpt-view.md'] = Transcript.render(conv, { conversationId: chat.id, names }).markdown;
    } catch (error) {
      docs.viewError = error.message;
    }
    if (others.length) {
      const body = others.map(node => renderMessage(node, `branch msg (parent ${String(node.parent).slice(0, 8)})`, names)).join('\n\n---\n\n');
      docs['branches.md'] = `# ${title} — edited/regenerated branches\n\n${body}\n`;
    }
    const thinking = [];
    for (const [list, label] of [[main, 'Message'], [others, 'Branch message']]) {
      list.forEach((node, i) => {
        const content = node.message.content || {};
        if (content.content_type === 'thoughts' || content.content_type === 'reasoning_recap') {
          const text = content.content_type === 'thoughts' ? thoughtsText(content) : `*${content.content || ''}*`;
          if (text.trim()) thinking.push(`## ${label} ${label === 'Message' ? i + 1 : node.id.slice(0, 8)} · ${isoTime(node.message.create_time)}\n\n${text}`);
        }
      });
    }
    if (thinking.length) {
      docs['thinking.md'] = `# Thinking — ${title}\n\n${thinking.join('\n\n---\n\n')}\n`;
      docs.thinkingBlocks = thinking.length;
    }
    return docs;
  }

  return Object.freeze({ FILE_ID, fileIdOf, messageText, messageTree, fence, clip, mdLink, toIso, isoDate, isoTime, renderMessage, documents });
})();
