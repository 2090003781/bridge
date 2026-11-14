// Bridge · 回复进来时视口停在哪
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickReplyAnchor, ROOM_RATIO, TAIL_LINES } = require('../src/lib/scroll-anchor.js');

// 常用场景：视口 600，行高 20
const base = { assistantTop: 960, viewHeight: 600, lineHeight: 20 };

test('短消息停在我那句话的顶部，整条和回复开头都看得见', () => {
  const got = pickReplyAnchor({ ...base, userTop: 900, userHeight: 60 });
  assert.equal(got, 900);
});

test('长消息（超过视口七成）停在最后两行，下面紧接着就是回复开头', () => {
  // 500px 的话，视口 600：视口里只留最后两行（40px），回复从第 41px 开始
  const got = pickReplyAnchor({ ...base, userTop: 100, userHeight: 500 });
  assert.equal(got, 100 + 500 - TAIL_LINES * 20);
});

test('长消息留的尾巴跟行高走：行高变大，锚点上移', () => {
  const got = pickReplyAnchor({ ...base, userTop: 100, userHeight: 500, lineHeight: 30 });
  assert.equal(got, 100 + 500 - TAIL_LINES * 30);
});

test('刚好等于阈值时仍然停在顶部（不算长）', () => {
  const viewHeight = 1000;
  const room = viewHeight * ROOM_RATIO;
  const got = pickReplyAnchor({ userTop: 0, userHeight: room, assistantTop: room, viewHeight, lineHeight: 20 });
  assert.equal(got, 0);
});

test('超过阈值一像素就算长，开始留尾巴', () => {
  const viewHeight = 1000;
  const room = viewHeight * ROOM_RATIO;
  const got = pickReplyAnchor({
    userTop: 0,
    userHeight: room + 1,
    assistantTop: room + 1,
    viewHeight,
    lineHeight: 20,
  });
  assert.equal(got, room + 1 - TAIL_LINES * 20);
});

test('行高拿不到就停在气泡底部，至少回复开头在顶上', () => {
  const got = pickReplyAnchor({ ...base, userTop: 100, userHeight: 500, lineHeight: null });
  assert.equal(got, 600);
});

test('不会滚到我那句话上面（尾巴比整条还高时夹回顶部）', () => {
  const got = pickReplyAnchor({ ...base, userTop: 100, userHeight: 30, lineHeight: 20, viewHeight: 10 });
  assert.equal(got, 100);
});

test('没有我那句（比如会话刚开）就停在回复开头', () => {
  assert.equal(pickReplyAnchor({ ...base, userTop: NaN, userHeight: NaN }), 960);
  assert.equal(pickReplyAnchor({ ...base, userTop: undefined }), 960);
});

test('连回复气泡都没有时返回 null，交给调用方滚到底', () => {
  assert.equal(pickReplyAnchor({ ...base, userTop: 100, userHeight: 60, assistantTop: NaN }), null);
  assert.equal(pickReplyAnchor({}), null);
});

test('位置算反了（用户气泡在回复下面）不硬按，停在我那句顶部', () => {
  assert.equal(pickReplyAnchor({ userTop: 500, userHeight: 60, assistantTop: 400, viewHeight: 600, lineHeight: 20 }), 500);
});

test('视口高度未知时不敢留尾巴，退回停在回复开头', () => {
  assert.equal(pickReplyAnchor({ ...base, userTop: 100, userHeight: 500, viewHeight: undefined }), 960);
  assert.equal(pickReplyAnchor({ ...base, userTop: 100, userHeight: 500, viewHeight: 0 }), 960);
});

test('高度未知但我那句话在，就按顶部对齐处理', () => {
  assert.equal(pickReplyAnchor({ ...base, userTop: 300, userHeight: NaN }), 300);
});
