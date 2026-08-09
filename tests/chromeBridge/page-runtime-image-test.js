'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const pageRuntimeModule = require('../../Plugin/ChromeBridge/VCPChrome/webcore/web-agent-page-runtime-core.js');

function installLayout(window) {
    window.innerWidth = 1280;
    window.innerHeight = 720;
    window.scrollX = 0;
    window.scrollY = 0;

    window.getComputedStyle = element => ({
        display: element.hidden ? 'none' : 'block',
        visibility: 'visible',
        opacity: '1',
        width: `${Number(element.dataset.width) || 640}px`,
        height: `${Number(element.dataset.height) || 360}px`,
        cursor: element.tagName === 'A' ? 'pointer' : 'auto'
    });

    window.Element.prototype.scrollIntoView = function scrollIntoView() {
        this.dataset.scrolledIntoView = 'true';
    };

    window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        const width = Number(this.dataset.width) || (this.tagName === 'IMG' ? 640 : 680);
        const height = Number(this.dataset.height) || (this.tagName === 'IMG' ? 360 : 80);
        const x = Number(this.dataset.x) || 40;
        const y = Number(this.dataset.y) || 80;
        return {
            x,
            y,
            left: x,
            top: y,
            right: x + width,
            bottom: y + height,
            width,
            height
        };
    };
}

function createFixture() {
    const html = `<!doctype html>
<html>
<head><title>正文图片测试新闻</title></head>
<body>
    <header>
        <img id="site-logo" class="site-logo" alt="网站 Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="240" data-height="100">
    </header>
    <main>
        <article id="news-article">
            <h1>火星探测器完成新一轮科学任务</h1>
            <p>探测器在目标区域完成巡视，并传回了大量地形和岩石图像。这些资料将用于分析区域地质历史和环境变化。</p>
            <figure>
                <img id="hero-image" alt="火星探测器在岩石区域工作" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="960" data-height="540" data-y="140">
                <figcaption>探测器拍摄的火星岩石区域</figcaption>
            </figure>
            <p>研究团队表示，图片中的层状地貌为后续采样路线提供了重要依据，任务将在未来数月继续进行。</p>
            <img id="inline-ad" class="advertisement sponsor-banner" alt="推广广告" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="900" data-height="180" data-y="500">
            <img id="author-avatar" class="author-avatar icon" alt="作者头像" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="160" data-height="160" data-y="560">
        </article>
        <section id="video-section">
            <h2>任务视频</h2>
            <a id="video-link" href="/video/mission">
                <img id="video-thumbnail" alt="火星任务完整视频" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="640" data-height="360" data-y="300">
                <span>火星探测任务完整视频回顾与科学解读</span>
            </a>
        </section>
    </main>
    <div class="_18p7x">
        <div class="EaCvy">
            <h1>随机类名新闻正文</h1>
            <p>这是一个模拟百家号页面的正文段落。真实页面使用随机类名和多层 div，而不是 article、main 或 figure 等语义标签。</p>
            <p>正文包含足够多的连续文本，用于证明图片位于密集文章内容祖先中，而不是导航、侧栏、推荐列表或广告模块。</p>
            <div class="_3hMwG">
                <div class="_1NCGf">
                    <img id="baijiahao-image" class="_1g4Ex _1i_Oe" src="https://pics3.baidu.com/feed/example.jpeg" data-width="1080" data-height="608" data-y="180">
                </div>
                <div class="image-caption">季昊天在指导学员。记者刘晨玮 摄</div>
            </div>
            <p>图片之后继续出现较长的新闻正文，介绍人物经历、现场情况和采访信息，从而形成完整的文章内容密度。</p>
        </div>
    </div>
    <aside>
        <img id="sidebar-promo" alt="侧栏推荐内容" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-width="320" data-height="180">
    </aside>
</body>
</html>`;

    const dom = new JSDOM(html, {
        url: 'https://news.example.test/mars-mission',
        pretendToBeVisual: true
    });
    installLayout(dom.window);
    return dom;
}

(async function run() {
    const dom = createFixture();
    const { window } = dom;
    const runtime = pageRuntimeModule.createWebAgentPageRuntime(
        {
            window,
            document: window.document,
            Node: window.Node
        },
        {
            runtimeInstanceId: 'runtime-image-test',
            documentGeneration: 4
        }
    );

    const snapshot = runtime.snapshot();
    const imageElementsById = new Map(
        snapshot.images.map(record => {
            const element = window.document.querySelector(
                `[data-vcp-image-id="${record.strictImageId}"]`
            );
            return [element?.id, record];
        })
    );

    assert.strictEqual(snapshot.imageCount, 3, '应保留语义正文图、视频缩略图和百家号随机容器正文图');
    assert(imageElementsById.has('hero-image'), '新闻正文插图应被识别');
    assert(imageElementsById.has('video-thumbnail'), '与视频标题相邻的缩略图应被识别');
    assert(imageElementsById.has('baijiahao-image'), '随机类名密集正文祖先中的百家号图片应被识别');
    assert(!imageElementsById.has('inline-ad'), '正文中的广告特征图片应被过滤');
    assert(!imageElementsById.has('author-avatar'), '头像或图标类图片应被过滤');
    assert(!imageElementsById.has('site-logo'), '页头 Logo 应被过滤');
    assert(!imageElementsById.has('sidebar-promo'), '非正文侧栏图片应被过滤');

    const hero = imageElementsById.get('hero-image');
    const video = imageElementsById.get('video-thumbnail');
    assert.strictEqual(hero.imageId, 'IMG1');
    const baijiahao = imageElementsById.get('baijiahao-image');
    assert.strictEqual(video.imageId, 'IMG2');
    assert.strictEqual(baijiahao.imageId, 'IMG3');
    assert.match(hero.strictImageId, /^vcp-img-4-1-1-[a-z0-9]+$/);
    assert.match(video.strictImageId, /^vcp-img-4-1-2-[a-z0-9]+$/);
    assert.match(baijiahao.strictImageId, /^vcp-img-4-1-3-[a-z0-9]+$/);
    assert.match(snapshot.markdown, /\[图片 IMG1｜探测器拍摄的火星岩石区域｜960×540｜id=vcp-img-/);
    assert.match(snapshot.markdown, /\[图片 IMG2｜火星任务完整视频｜640×360｜id=vcp-img-/);
    assert.match(snapshot.markdown, /\[图片 IMG3｜季昊天在指导学员。记者刘晨玮 摄｜1080×608｜id=vcp-img-/);
    assert.strictEqual(baijiahao.primaryReason, 'dense-content-ancestor');
    assert.strictEqual(snapshot.pageGraph.images.length, 3);

    const shortIdResult = await runtime.execute('page_get_image', {
        imageId: hero.imageId,
        targetContext: {
            runtimeInstanceId: snapshot.runtimeInstanceId,
            documentGeneration: snapshot.documentGeneration,
            snapshotId: snapshot.snapshotId
        },
        strict: true
    }, { strict: true });

    assert.strictEqual(shortIdResult.status, 'success');
    assert.strictEqual(shortIdResult.code, 'PAGE_IMAGE_RESOLVED');
    assert.strictEqual(shortIdResult.result.resolvedImageId, hero.strictImageId);
    assert.deepStrictEqual(shortIdResult.result.viewportRect, {
        x: 40,
        y: 140,
        width: 960,
        height: 540
    });
    assert.strictEqual(
        window.document.getElementById('hero-image').dataset.scrolledIntoView,
        'true',
        '解析图片时应滚动到可视区域'
    );

    const strictIdResult = await runtime.execute('page_get_image', {
        imageId: video.strictImageId,
        targetContext: {
            runtimeInstanceId: snapshot.runtimeInstanceId,
            documentGeneration: snapshot.documentGeneration,
            snapshotId: snapshot.snapshotId
        },
        strict: true
    }, { strict: true });
    assert.strictEqual(strictIdResult.result.imageId, video.imageId);

    const repeatedSnapshot = runtime.snapshot();
    assert.strictEqual(repeatedSnapshot.imageCount, 3, '后续快照不得因上一轮 data-vcp-handle 跳过图片子树');
    assert.match(repeatedSnapshot.markdown, /\[图片 IMG3｜季昊天在指导学员。记者刘晨玮 摄｜1080×608｜id=vcp-img-/);

    assert.throws(
        () => runtime.resolveTarget('vcp-img-4-1-1-deadbeef'),
        /未找到目标|不在当前/,
        '图片 ID 不应被普通交互元素解析器接受'
    );

    await assert.rejects(
        runtime.execute('page_get_image', {
            imageId: 'vcp-img-3-1-1-deadbeef'
        }),
        error => error.code === 'IMAGE_HANDLE_EXPIRED',
        '旧文档代次的图片严格 ID 必须失效'
    );

    console.log('Page Runtime 正文图片发现、过滤与解析测试通过');
    console.log(JSON.stringify({
        runtimeVersion: runtime.version,
        documentGeneration: snapshot.documentGeneration,
        snapshotId: snapshot.snapshotId,
        imageCount: snapshot.imageCount,
        repeatedSnapshotImageCount: repeatedSnapshot.imageCount,
        selectedElements: Array.from(imageElementsById.keys()),
        imageIds: snapshot.images.map(item => item.imageId),
        strictIds: snapshot.images.map(item => item.strictImageId)
    }, null, 2));
})();