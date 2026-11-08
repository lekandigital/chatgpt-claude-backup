import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { core, json, jobHarness, until } from './helpers.mjs';

// Real-structure fixtures from pionxzh/chatgpt-exporter (MIT), see THIRD_PARTY_NOTICES.md.
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const node = (id, parent, children, message) => ({ id, parent, children, message });
const msg = (role, content, extra = {}) => ({ author: { role }, recipient: 'all', create_time: 1793200000, content, ...extra });
const text = (...parts) => ({ content_type: 'text', parts });

function synthetic() {
  return { title: 'Trip [planning] notes', create_time: 1793200000, update_time: 1793203600, default_model_slug: 'gpt-5-5', current_node: 'a3',
    mapping: {
      root: node('root', null, ['sys'], null),
      sys: node('sys', 'root', ['ctx'], msg('system', text('You are ChatGPT'))),
      ctx: node('ctx', 'sys', ['u1'], msg('user', { content_type: 'user_editable_context', user_profile: 'PRIVATE PROFILE' })),
      u1: node('u1', 'ctx', ['a1', 'alt'], msg('user', text('Where should I go?'), { metadata: { attachments: [
        { id: 'file_doc', name: 'itinerary.pdf', mime_type: 'application/pdf' }, { id: 'file_img', name: 'photo.png', mime_type: 'image/png' }] } })),
      alt: node('alt', 'u1', [], msg('assistant', text('ABANDONED BRANCH'))),
      a1: node('a1', 'u1', ['tool'], msg('assistant', text('search'), { recipient: 'web.run' })),
      tool: node('tool', 'a1', ['a2'], msg('tool', text('RAW TOOL OUTPUT'), { author: { role: 'tool', name: 'web.run' } })),
      a2: node('a2', 'tool', ['a3'], msg('assistant', text('Lisbon is lovely \uE200cite\uE202turn0search0\uE201 and cheap.\uE200cite\uE202turn9\uE201'), { metadata: {
        content_references: [
          { matched_text: '\uE200cite\uE202turn0search0\uE201', type: 'grouped_webpages', items: [{ title: 'Visit Lisbon', url: 'https://visitlisbon.example/guide' }] },
          { type: 'sources_footnote', sources: [{ title: 'Visit Lisbon', url: 'https://visitlisbon.example/guide' }, { title: 'Travel [Blog]', url: 'https://blog.example/x' }] },
        ] } })),
      a3: node('a3', 'a2', [], msg('assistant', { content_type: 'code', language: 'python', text: 'print("```")' })),
    } };
}
test('the visible branch is rendered; hidden, tool, system and alternative-branch messages are not', () => {
  const { Transcript } = core();
  const names = new Map([['file_doc', 'itinerary #2.pdf']]);
  const { markdown, messages, title } = Transcript.render(synthetic(), { conversationId: 'abc', names, exportedAt: Date.UTC(2026, 9, 28, 12) });
  assert.equal(title, 'Trip [planning] notes'); assert.equal(messages, 2);
  for (const hidden of ['You are ChatGPT', 'PRIVATE PROFILE', 'ABANDONED BRANCH', 'RAW TOOL OUTPUT', 'search\n', '\uE200', '\uE201', 'photo.png']) {
    assert.ok(!markdown.includes(hidden), hidden);
  }
  assert.match(markdown, /^# Trip \[planning\] notes\n/);
  assert.ok(markdown.includes('- Conversation: <https://chatgpt.com/c/abc>'));
  assert.ok(markdown.includes('- Model: gpt-5-5'));
  assert.ok(markdown.includes('### You · 2026-10-28'));
  // Attachments link to the downloaded files by their saved names, escaped for Markdown.
  assert.ok(markdown.includes('- 📎 [itinerary.pdf](<itinerary %232.pdf>)'));
  assert.ok(markdown.includes('Lisbon is lovely ([Visit Lisbon](<https://visitlisbon.example/guide>)) and cheap.'));
  assert.ok(markdown.includes('**Sources:**\n\n- [Visit Lisbon](<https://visitlisbon.example/guide>)\n- [Travel \\[Blog\\]](<https://blog.example/x>)'));
  // The code reply continues the same ChatGPT turn, fenced so its own backticks cannot close it.
  assert.equal(markdown.match(/### ChatGPT/g).length, 1);
  assert.ok(markdown.includes('````python\nprint("```")\n````'));
});
test('real fixture: reasoning and tool calls are left out, question/answer order is kept', async () => {
  const { Transcript } = core();
  const { markdown, messages } = Transcript.render(await fixture('thinking-summaries'));
  assert.equal(messages, 4);
  const order = ['question 1', 'answer 1', 'question 2', 'answer 2'].map(part => markdown.indexOf(part));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), JSON.stringify(order));
  for (const hidden of ['thought 1', 'summary 1', 'Thought for 29s']) assert.ok(!markdown.includes(hidden), hidden);
});
test('real fixture: generated images link to downloaded files; hidden tool text and tool calls are skipped', async () => {
  const { Transcript } = core();
  const { markdown } = Transcript.render(await fixture('image-generation'), { names: new Map([['file_2', 'generated cat.png']]) });
  assert.ok(markdown.includes('![generated cat.png](<generated cat.png>)'));
  assert.ok(markdown.includes('[image]'));
  for (const hidden of ['tool text 2', 'tool text 4', 'code 1', 'code 2']) assert.ok(!markdown.includes(hidden), hidden);
  for (const question of ['question 2', 'question 3', 'question 4']) assert.ok(markdown.includes(question), question);
});
test('a missing current_node falls back to a leaf, and malformed data is not a conversation', () => {
  const { Transcript } = core();
  const data = synthetic(); delete data.current_node;
  assert.ok(Transcript.render(data).messages >= 1);
  for (const value of [null, [], {}, { mapping: [] }, { detail: 'Not found' }]) assert.equal(Transcript.isConversation(value), false);
});
function conversationRoute(files, conversation, extra = async () => new Response('data')) {
  return async (url, init) => {
    if (url.includes('/conversations/')) return json({ files });
    if (url.includes('/backend-api/conversation/')) return typeof conversation === 'function' ? conversation(init) : json(conversation);
    return extra(url, init);
  };
}
test('Save transcript downloads Markdown or the unchanged JSON under the conversation title, without a scan', async () => {
  const data = synthetic();
  const h = jobHarness(conversationRoute([], data));
  assert.equal(h.command('EXPORT_TRANSCRIPT', { format: 'markdown' }).ok, true);
  await until(() => h.job.snapshot().transcript.status === 'saved');
  assert.equal(h.saves[0].filename, 'Trip [planning] notes (transcript).md');
  assert.ok((await h.saves[0].blob.text()).includes('### ChatGPT'));
  assert.equal(h.job.snapshot().transcript.messages, 2);
  h.command('EXPORT_TRANSCRIPT', { format: 'json' });
  await until(() => h.saves.length === 2);
  assert.equal(h.saves[1].filename, 'Trip [planning] notes (transcript).json');
  assert.deepEqual(JSON.parse(await h.saves[1].blob.text()), data);
  assert.equal(h.command('EXPORT_TRANSCRIPT', { format: 'pdf' }).ok, false);
});
test('Download all with the transcript saves it last, linked to the saved attachment names', async () => {
  const data = synthetic();
  const h = jobHarness(conversationRoute([{ id: 'file_doc', name: 'itinerary.pdf' }, { id: 'file_b', name: 'b.txt' }], data,
    async url => new Response(url.includes('file_doc') ? '%PDF-1.7 x' : 'b')));
  await h.scan(); h.command('START_DOWNLOADS', { transcript: true }); await h.finish();
  assert.deepEqual(h.saves.map(s => s.filename), ['itinerary.pdf', 'b.txt', 'Trip [planning] notes (transcript).md']);
  assert.ok((await h.saves[2].blob.text()).includes('[itinerary.pdf](<itinerary.pdf>)'));
  assert.equal(h.job.snapshot().batch.status, 'completed');
  // Everything downloaded already: Download all still saves the transcript alone.
  h.command('START_DOWNLOADS', { transcript: true });
  await until(() => h.saves.length === 4);
  assert.equal(h.saves[3].filename, 'Trip [planning] notes (transcript).md');
});
test('a failed transcript does not fail the batch; an HTML or non-conversation response is not saved', async () => {
  for (const response of [() => new Response('', { status: 404 }), () => new Response('<!doctype html><html>', { headers: { 'content-type': 'text/html' } }), () => json({ detail: 'x' })]) {
    const h = jobHarness(conversationRoute([{ id: 'file_a', name: 'a.txt' }], response));
    await h.scan(); h.command('START_DOWNLOADS', { transcript: true }); await h.finish();
    assert.deepEqual(h.saves.map(s => s.filename), ['a.txt']);
    assert.equal(h.job.snapshot().batch.status, 'completed');
    assert.equal(h.job.snapshot().transcript.status, 'failed');
    assert.equal(h.job.snapshot().error, null);
  }
});
test('Stop cancels a transcript request', async () => {
  let fetching = false;
  const h = jobHarness(conversationRoute([], init => {
    fetching = true;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  }));
  h.command('EXPORT_TRANSCRIPT', { format: 'markdown' }); await until(() => fetching);
  h.command('STOP_DOWNLOADS');
  await until(() => h.job.snapshot().transcript.status === 'idle');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.saves.length, 0);
  assert.equal(h.command('SCAN_FILES').ok, true);
});

test('writing blocks keep their full text, entities their names, image groups their queries', () => {
  const { Transcript } = core();
  const block = ':::writing{variant="document" id="7"}\n# Draft\nThe whole drafted document.\n:::';
  const reply = `Here is the prompt:\n\n${block}\n\nStudy \uE200entity\uE202["video_game","Vampire Survivors"]\uE201 next.\n\uE200image_group\uE202{"query":["Minecraft base"]}\uE201`;
  const markdown = Transcript.citations(reply, { content_references: [
    { type: 'client_defined_widget', matched_text: block, alt: null, data: { widget_type: 'writing_block', content: '# Draft\nThe whole drafted document.' } }] });
  assert.ok(markdown.includes('# Draft\nThe whole drafted document.'));
  const email = ':::writing{variant="email" id="9" subject="Great speaking today!"}\nHi Ana,\n:::';
  const mail = Transcript.citations(email, { content_references: [{ type: 'client_defined_widget', matched_text: email, data: { widget_type: 'writing_block', variant: 'email', content: 'Hi Ana,' } }] });
  assert.ok(mail.includes('*Draft email · Subject: Great speaking today!*\n\nHi Ana,'));
  assert.ok(!markdown.includes(':::writing'));
  assert.ok(markdown.includes('Study Vampire Survivors next.'));
  assert.ok(markdown.includes('*(Images: Minecraft base)*'));
  assert.ok(!/[\uE200-\uE204]/.test(markdown));
});

test('older file-service:// image pointers link to the saved file, not the scheme', () => {
  const { Transcript } = core();
  const message = { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-AbC123xyz' }, 'what is this?'] } };
  const out = Transcript.body(message, new Map([['file-AbC123xyz', 'uploads/photo.png']]));
  assert.ok(out.includes('(<uploads/photo.png>)'), out);
});

test('references never strip spaces, drop final-output drafts, or delete prose they cannot replace', () => {
  const { Transcript } = core();
  // A "hidden" reference on a single space once removed every space in the reply.
  const plain = 'I am not quite sure what you need. Could you say more?';
  assert.equal(Transcript.citations(plain, { content_references: [{ type: 'hidden', matched_text: ' ', start_idx: 10, end_idx: 10 }] }), plain);
  // writing_block_final_output carries no data.content: the draft is the block's own text.
  const draft = ':::writing{variant="chat_message" id="73264"}\nHi Katherine, thank you for waiting.\n\nThe brief.\n:::';
  const reply = `Send this in JoinBrands:\n\n${draft}\n\nThen send the script.`;
  const out = Transcript.citations(reply, { content_references: [{ type: 'client_defined_widget', matched_text: draft, alt: null, data: { widget_type: 'writing_block_final_output' } }] });
  assert.ok(out.includes('Hi Katherine, thank you for waiting.\n\nThe brief.'), out);
  assert.ok(out.includes('*Draft chat message*'), out);
  assert.ok(!out.includes(':::writing'), out);
  // A reference with no alt or sources over plain words keeps the words.
  assert.ok(Transcript.citations('See it [here](11) now.', { content_references: [{ type: 'webpage_extended', matched_text: '[here](11)' }] }).includes('here'));
  // Citation markers without anything to show are still removed.
  assert.equal(Transcript.citations('Fact.\uE200cite\uE202turn0search1\uE201', { content_references: [{ type: 'grouped_webpages', matched_text: '\uE200cite\uE202turn0search1\uE201', items: [] }] }), 'Fact.');
});

test('products, links and other shown elements keep their names; citations still become sources', () => {
  const { Transcript } = core();
  const entity = 'entity["turn0product2","Ewo Lp97 Lamp",0]';
  const product = Transcript.citations(`Is **${entity}** reliable?`, { content_references: [{ type: 'product_entity', matched_text: entity,
    alt: '[Ewo Lp97 Lamp](https://shop.example/lamp)', safe_urls: ['https://shop.example/lamp'] }] });
  assert.equal(product, 'Is **[Ewo Lp97 Lamp](https://shop.example/lamp)** reliable?');
  const carousel = 'products{"selections":[\n["turn0product1","GPU A"],\n["turn0product2","GPU B"]\n]}';
  const listed = Transcript.citations(`Options:\n\n${carousel}`, { content_references: [{ type: 'products', matched_text: carousel,
    alt: '### [GPU A](https://a.example)\n*$10*\n\n### [GPU B](https://b.example)\n*$20*', safe_urls: ['https://a.example'] }] });
  assert.ok(listed.includes('[GPU A](https://a.example)') && listed.includes('*$20*'), listed);
  const bare = 'product["turn0product1","WD My Passport"]';
  assert.equal(Transcript.citations(bare, { content_references: [{ type: 'product', matched_text: bare, safe_urls: ['https://wd.example'] }] }),
    '[WD My Passport](https://wd.example)');
  const time = 'timeturn0time0';
  assert.equal(Transcript.citations(`Now: ${time}`, { content_references: [{ type: 'time', matched_text: time, alt: 'Aug 18, 2025, 8:34 PM', safe_urls: ['https://time.example'] }] }),
    'Now: Aug 18, 2025, 8:34 PM');
  const cite = 'citeturn0search1';
  assert.equal(Transcript.citations(`Fact.${cite}`, { content_references: [{ type: 'grouped_webpages', matched_text: cite, alt: '([Site](https://s.example))',
    items: [{ title: 'Site', url: 'https://s.example' }] }] }), 'Fact.([Site](<https://s.example>))');
});

test('product markers keep their names even when the recorded reference text does not match', () => {
  const { Transcript } = core();
  const marker = 'products{"selections":[["turn1product0","Palit 4090 (retail)"],["turn0product0","Palit 4090 (parts)"]],"tags":["new","parts"]}';
  const shortened = 'products{"selections":[["turn1product0","Palit 4090 (retail)"],["turn0product0","Palit 4090 (parts)"]]}';
  const withAlt = Transcript.citations(`Listings:\n\n${marker}`, { content_references: [{ type: 'products', matched_text: shortened,
    alt: '### [Palit 4090 (retail)](https://shop.example/r)\n*$3,930*', safe_urls: ['https://shop.example/r'] }] });
  assert.ok(withAlt.includes('[Palit 4090 (retail)](https://shop.example/r)'), withAlt);
  const entity = 'product_entity["turn1product0","Palit 4090 (retail)"]';
  assert.equal(Transcript.citations(`Buy **${entity}**`, { content_references: [] }), 'Buy **Palit 4090 (retail)**');
  assert.ok(Transcript.citations(marker, { content_references: [] }).includes('Palit 4090 (parts)'));
});
