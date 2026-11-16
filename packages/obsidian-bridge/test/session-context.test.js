// Bridge · 切换会话时窗口里该显示什么
const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptState, mergeTranscript, HISTORY_LIMIT } = require('../src/lib/session-context.js');

test('同一次切换、同一个会话：历史该落到窗口上', () => {
  assert.equal(
    transcriptState({ reqToken: 3, curToken: 3, reqSession: 'session-a', curSession: 'session-a' }),
    'apply'
  );
});

test('切过去又切回来了：旧请求作废，不能拿它当新会话的历史', () => {
  assert.equal(
    transcriptState({ reqToken: 2, curToken: 4, reqSession: 'session-a', curSession: 'session-a' }),
    'stale'
  );
});

test('会话对不上：迟到的上一条会话历史不能盖掉当前窗口', () => {
  assert.equal(
    transcriptState({ reqToken: 5, curToken: 5, reqSession: 'session-old', curSession: 'session-new' }),
    'stale'
  );
});

test('两边会话都不知道时只认 token，不乱丢历史', () => {
  assert.equal(transcriptState({ reqToken: 1, curToken: 1 }), 'apply');
  assert.equal(transcriptState({ reqToken: 1, curToken: 2 }), 'stale');
});

test('历史打底，加载期间新到的消息接在后面', () => {
  const transcript = [
    { role: 'user', text: '早' },
    { role: 'assistant', text: '在' },
  ];
  const live = [{ role: 'user', text: '刚发的' }];
  assert.deepEqual(mergeTranscript({ transcript, live }), [
    { role: 'user', text: '早' },
    { role: 'assistant', text: '在' },
    { role: 'user', text: '刚发的' },
  ]);
});

test('同一条消息历史和实时都有：只留一份', () => {
  const transcript = [
    { role: 'user', text: '早' },
    { role: 'assistant', text: '在的' },
  ];
  const live = [{ role: 'assistant', text: '在的' }];
  assert.deepEqual(mergeTranscript({ transcript, live }), transcript);
});

test('角色不同但文字一样，不算重复', () => {
  const transcript = [{ role: 'assistant', text: '嗯' }];
  const live = [{ role: 'user', text: '嗯' }];
  assert.equal(mergeTranscript({ transcript, live }).length, 2);
});

test('没有历史就只有实时；都没有就是空', () => {
  assert.deepEqual(mergeTranscript({ transcript: [], live: [{ role: 'user', text: 'x' }] }), [
    { role: 'user', text: 'x' },
  ]);
  assert.deepEqual(mergeTranscript({}), []);
  assert.deepEqual(mergeTranscript({ transcript: null, live: null }), []);
});

test('切换时只要最近十条，不要一屏历史', () => {
  assert.equal(HISTORY_LIMIT, 10);
});
