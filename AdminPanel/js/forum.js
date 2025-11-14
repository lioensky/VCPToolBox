// AdminPanel/js/forum.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let allForumPosts = [];

/**
 * 初始化 VCP 论坛。
 */
export async function initializeVCPForum() {
    console.log('Initializing VCP Forum...');
    const forumPostsContainer = document.getElementById('forum-posts-container');
    const forumBoardFilter = document.getElementById('forum-board-filter');
    const forumSearchInput = document.getElementById('forum-search-input');

    if (!forumPostsContainer || !forumBoardFilter) return;

    forumPostsContainer.innerHTML = '<p>正在加载论坛帖子...</p>';
    forumBoardFilter.innerHTML = '<option value="all">全部板块</option>';
    if (forumSearchInput) forumSearchInput.value = '';
    
    setupEventListeners();

    try {
        const data = await apiFetch(`${API_BASE_URL}/forum/posts`);
        allForumPosts = data.posts || [];
        populateForumFilter(allForumPosts);
        renderForumPosts(allForumPosts);
    } catch (error) {
        forumPostsContainer.innerHTML = `<p class="error-message">加载论坛帖子失败: ${error.message}</p>`;
        showMessage(`加载论坛帖子失败: ${error.message}`, 'error');
    }
}

/**
 * 设置论坛部分的事件监听器。
 */
function setupEventListeners() {
    const forumBoardFilter = document.getElementById('forum-board-filter');
    const forumSearchInput = document.getElementById('forum-search-input');

    if (forumBoardFilter && !forumBoardFilter.dataset.listenerAttached) {
        forumBoardFilter.addEventListener('change', filterAndRenderPosts);
        forumBoardFilter.dataset.listenerAttached = 'true';
    }
    if (forumSearchInput && !forumSearchInput.dataset.listenerAttached) {
        forumSearchInput.addEventListener('input', filterAndRenderPosts);
        forumSearchInput.dataset.listenerAttached = 'true';
    }
}

function populateForumFilter(posts) {
    const forumBoardFilter = document.getElementById('forum-board-filter');
    if (!forumBoardFilter) return;
    const boards = new Set(posts.map(p => p.board).filter(Boolean));
    boards.forEach(board => {
        const option = document.createElement('option');
        option.value = board;
        option.textContent = board;
        forumBoardFilter.appendChild(option);
    });
}

function renderForumPosts(posts) {
    const forumPostsContainer = document.getElementById('forum-posts-container');
    if (!forumPostsContainer) return;
    forumPostsContainer.innerHTML = '';
    if (posts.length === 0) {
        forumPostsContainer.innerHTML = '<p>没有找到任何帖子。</p>';
        return;
    }

    posts.sort((a, b) => {
        const aIsPinned = a.title.includes('[置顶]');
        const bIsPinned = b.title.includes('[置顶]');
        if (aIsPinned && !bIsPinned) return -1;
        if (!aIsPinned && bIsPinned) return 1;
        const dateA = new Date(a.lastReplyAt || a.timestamp.replace(/-/g, ':'));
        const dateB = new Date(b.lastReplyAt || b.timestamp.replace(/-/g, ':'));
        return dateB - dateA;
    });

    const table = document.createElement('table');
    table.className = 'forum-posts-list';
    table.innerHTML = `
        <thead>
            <tr>
                <th style="width: 15%;">板块</th>
                <th style="width: 50%;">标题</th>
                <th style="width: 15%;">作者</th>
                <th style="width: 20%;">最后回复</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    posts.forEach(post => {
        const tr = document.createElement('tr');
        tr.dataset.uid = post.uid;
        tr.addEventListener('click', () => viewForumPost(post.uid));
        if (post.title.includes('[置顶]')) {
            tr.classList.add('pinned-post');
        }

        const lastReplyDate = new Date(post.lastReplyAt || post.timestamp.replace(/-/g, ':'));
        const lastReplyText = post.lastReplyBy
            ? `${post.lastReplyBy} <br> ${lastReplyDate.toLocaleString()}`
            : `N/A <br> ${new Date(post.timestamp.replace(/-/g, ':')).toLocaleString()}`;

        tr.innerHTML = `
            <td><span class="post-meta">[${post.board}]</span></td>
            <td><span class="post-title">${post.title}</span></td>
            <td><span class="post-meta">${post.author}</span></td>
            <td><span class="post-meta">${lastReplyText}</span></td>
        `;
        tbody.appendChild(tr);
    });
    forumPostsContainer.appendChild(table);
}

async function viewForumPost(uid) {
    const forumPostsContainer = document.getElementById('forum-posts-container');
    if (!forumPostsContainer) return;
    try {
        const data = await apiFetch(`${API_BASE_URL}/forum/post/${uid}`);
        const content = data.content;
        const replyDelimiter = '\n\n---\n\n## 评论区\n---';
        let mainContent = content;
        let repliesContent = '';

        const delimiterIndex = content.indexOf(replyDelimiter);
        if (delimiterIndex !== -1) {
            mainContent = content.substring(0, delimiterIndex);
            repliesContent = content.substring(delimiterIndex + replyDelimiter.length);
        }

        const renderedMainContent = marked.parse(mainContent);
        const titleMatch = mainContent.match(/^# (.*)$/m);
        const postTitle = titleMatch ? titleMatch[1] : '帖子详情';

        let repliesHtml = '';
        if (repliesContent.trim()) {
            const replies = repliesContent.trim().split('\n\n---\n');
            repliesHtml = replies.map((reply, index) => {
                if (!reply.trim()) return '';
                const floor = index + 1;
                const replyHtml = marked.parse(reply.trim());
                return `
                    <div class="forum-reply-item" data-floor="${floor}">
                        ${replyHtml}
                        <div class="item-actions">
                            <button class="delete-floor-btn danger-btn" data-uid="${uid}" data-floor="${floor}">删除此楼层</button>
                        </div>
                    </div>`;
            }).join('');
        }

        forumPostsContainer.innerHTML = `
            <div class="form-actions">
                <button id="back-to-forum-list"><span class="material-symbols-outlined">arrow_back</span> 返回列表</button>
                <button id="delete-post-btn" class="danger-btn" data-uid="${uid}">删除整个帖子</button>
            </div>
            <h2>${postTitle}</h2>
            <div class="forum-post-content-view">${renderedMainContent}</div>
            <div class="forum-replies-container">${repliesHtml}</div>
            <div class="forum-reply-area">
                <h3>发表回复</h3>
                <input type="text" id="forum-reply-name" placeholder="您的昵称 (必填)" required>
                <textarea id="forum-reply-content" placeholder="输入您的回复内容 (支持Markdown)..." required></textarea>
                <button id="submit-forum-reply" data-uid="${uid}">提交回复</button>
                <span id="forum-reply-status" class="status-message"></span>
            </div>
        `;

        document.getElementById('back-to-forum-list').addEventListener('click', () => {
            filterAndRenderPosts();
        });
        document.getElementById('submit-forum-reply').addEventListener('click', handleForumReply);
        document.getElementById('delete-post-btn').addEventListener('click', handleDeletePostOrFloor);
        document.querySelectorAll('.delete-floor-btn').forEach(btn => {
            btn.addEventListener('click', handleDeletePostOrFloor);
        });

    } catch (error) {
        showMessage(`加载帖子内容失败: ${error.message}`, 'error');
    }
}

async function handleDeletePostOrFloor(event) {
    const button = event.target;
    const uid = button.dataset.uid;
    const floor = button.dataset.floor;

    const confirmMessage = floor
        ? `您确定要删除这个帖子的第 ${floor} 楼吗？`
        : `您确定要删除整个帖子 "${uid}" 吗？此操作无法撤销。`;

    if (!confirm(confirmMessage)) return;

    try {
        const options = {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
        };
        if (floor) {
            options.body = JSON.stringify({ floor });
        } else {
            // 删除整个帖子时，发送空对象以避免body解析错误
            options.body = JSON.stringify({});
        }

        const response = await apiFetch(`${API_BASE_URL}/forum/post/${uid}`, options);
        showMessage(response.message, 'success');

        if (floor) {
            viewForumPost(uid);
        } else {
            initializeVCPForum();
        }
    } catch (error) {
        showMessage(`删除失败: ${error.message}`, 'error');
    }
}

async function handleForumReply(event) {
    const uid = event.target.dataset.uid;
    const nameInput = document.getElementById('forum-reply-name');
    const contentInput = document.getElementById('forum-reply-content');
    const statusSpan = document.getElementById('forum-reply-status');

    const maid = nameInput.value.trim();
    const content = contentInput.value.trim();

    if (!maid || !content) {
        showMessage('昵称和回复内容不能为空！', 'error');
        return;
    }

    statusSpan.textContent = '正在提交...';
    statusSpan.className = 'status-message info';

    try {
        await apiFetch(`${API_BASE_URL}/forum/reply/${uid}`, {
            method: 'POST',
            body: JSON.stringify({ maid, content })
        });
        showMessage('回复成功！', 'success');
        viewForumPost(uid);
    } catch (error) {
        statusSpan.textContent = `回复失败: ${error.message}`;
        statusSpan.className = 'status-message error';
    }
}

function filterAndRenderPosts() {
    const forumBoardFilter = document.getElementById('forum-board-filter');
    const forumSearchInput = document.getElementById('forum-search-input');
    const selectedBoard = forumBoardFilter.value;
    const searchTerm = forumSearchInput.value.toLowerCase().trim();

    let filteredPosts = allForumPosts;

    if (selectedBoard !== 'all') {
        filteredPosts = filteredPosts.filter(p => p.board === selectedBoard);
    }

    if (searchTerm) {
        filteredPosts = filteredPosts.filter(p =>
            p.title.toLowerCase().includes(searchTerm) ||
            p.author.toLowerCase().includes(searchTerm)
        );
    }

    renderForumPosts(filteredPosts);
}