// Bridge · 面板里显示图片：本地绝对路径换成 Obsidian 认的写法
const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteLocalImages, isAbsoluteLocal, relativeToRoot } = require('../src/lib/image-embed.js');

const VAULT = 'D:\\个人数据\\辞玖';
const fakeRead = (files) => (p) => {
  const hit = files[p.replace(/\\/g, '/')] || files[p];
  return hit === undefined ? null : Buffer.from(hit, 'utf8');
};

test('库内的绝对路径换成库相对路径（Obsidian 才认）', () => {
  const out = rewriteLocalImages('![图](D:\\个人数据\\辞玖\\附件\\a.png)', { vaultRoot: VAULT });
  assert.equal(out, '![图](附件/a.png)');
});

test('库外的绝对路径读成 data URL 塞进去', () => {
  const out = rewriteLocalImages('![截图](C:\\Users\\x\\shot.png)', {
    vaultRoot: VAULT,
    readFile: fakeRead({ 'C:/Users/x/shot.png': 'PNGDATA' }),
  });
  assert.equal(out, '![截图](data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64') + ')');
});

test('库外文件读不到：原样留着，不编一个坏链', () => {
  const src = '![截图](C:\\Users\\x\\missing.png)';
  assert.equal(rewriteLocalImages(src, { vaultRoot: VAULT, readFile: fakeRead({}) }), src);
});

test('不是图片的扩展名不塞 data URL（避免把任意文件变成内联）', () => {
  const src = '![日志](C:\\Users\\x\\a.log)';
  const out = rewriteLocalImages(src, {
    vaultRoot: VAULT,
    readFile: fakeRead({ 'C:/Users/x/a.log': 'hello' }),
  });
  assert.equal(out, src);
});

test('网络图片、data URL、库内相对路径一律不动', () => {
  for (const src of [
    '![a](https://example.com/a.png)',
    '![b](data:image/png;base64,AAA)',
    '![c](附件/c.png)',
    '![d](<附件/d e.png>)',
  ]) {
    assert.equal(rewriteLocalImages(src, { vaultRoot: VAULT }), src);
  }
});

test('超过体积上限的图不内联（面板不该被一张大图拖死）', () => {
  const big = 'x'.repeat(300);
  const src = '![大图](C:\\Users\\x\\big.png)';
  const out = rewriteLocalImages(src, {
    vaultRoot: VAULT,
    maxBytes: 100,
    readFile: fakeRead({ 'C:/Users/x/big.png': big }),
  });
  assert.equal(out, src);
});

test('路径里有空格：换成库相对路径后仍然用 < > 包着', () => {
  const out = rewriteLocalImages('![x](<D:\\个人数据\\辞玖\\附件\\a b.png>)', { vaultRoot: VAULT });
  assert.equal(out, '![x](<附件/a b.png>)');
});

test('路径里没空格就不加 < >，别把普通链接写成怪样子', () => {
  const out = rewriteLocalImages('![x](<D:\\个人数据\\辞玖\\附件\\ab.png>)', { vaultRoot: VAULT });
  assert.equal(out, '![x](附件/ab.png)');
});

test('一段文字里有多张图，各自处理，其他内容不动', () => {
  const src =
    '开头\n![库内](D:\\个人数据\\辞玖\\a.png)\n中间 ![](C:\\Users\\x\\b.jpg)\n结尾';
  const out = rewriteLocalImages(src, {
    vaultRoot: VAULT,
    readFile: fakeRead({ 'C:/Users/x/b.jpg': 'JPG' }),
  });
  assert.ok(out.includes('![库内](a.png)'));
  assert.ok(out.includes('data:image/jpeg;base64,' + Buffer.from('JPG').toString('base64')));
  assert.ok(out.startsWith('开头\n'));
  assert.ok(out.endsWith('结尾'));
});

test('识别哪种路径算本地绝对路径', () => {
  assert.equal(isAbsoluteLocal('C:\\a.png'), true);
  assert.equal(isAbsoluteLocal('d:/a.png'), true);
  assert.equal(isAbsoluteLocal('\\\\server\\share\\a.png'), true);
  assert.equal(isAbsoluteLocal('a/b.png'), false);
  assert.equal(isAbsoluteLocal('https://x/a.png'), false);
});

test('求库相对路径：大小写和斜杠都按路径规则比', () => {
  assert.equal(relativeToRoot(VAULT, 'd:/个人数据/辞玖/附件/a.png'), '附件/a.png');
  assert.equal(relativeToRoot(VAULT, 'D:\\个人数据\\辞玖\\a.png'), 'a.png');
  assert.equal(relativeToRoot(VAULT, 'D:\\别的地方\\a.png'), null);
  assert.equal(relativeToRoot('', 'D:\\a.png'), null);
});

test('素材缺失时不炸：空字符串照样返回空字符串', () => {
  assert.equal(rewriteLocalImages('', { vaultRoot: VAULT }), '');
  assert.equal(rewriteLocalImages(undefined, { vaultRoot: VAULT }), '');
});
