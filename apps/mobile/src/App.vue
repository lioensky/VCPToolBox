<script setup>
import {ref,computed,onMounted,onUnmounted,nextTick} from 'vue';
const paired=ref(false),pairCode=ref(''),topics=ref([]),selected=ref(''),agentId=ref(''),messages=ref([]),jobs=ref([]),text=ref(''),busy=ref(false),notice=ref('正在连接…'),online=ref(false),history=ref(null);
const settingsOpen=ref(false),serverUrl=ref(''),accessKey=ref(''),server=ref(null),tested=ref(false);
let timer,lastSubmission=null,refreshing=false,historyKey='',cursor=0,historyRows=new Map(),generation=0;
const labels={preparing:'正在持久保存',queued:'已接受 · 等待执行',running:'服务端执行中',cancelling:'正在取消',cancelled:'已取消',publishing:'正在保存回复',completed:'回复已保存',failed:'执行失败'};
const agents=computed(()=>[...new Map(topics.value.map(t=>[t.ownerId||t.agentName,{id:t.ownerId||t.agentName,name:t.agentName,avatar:t.avatar,model:t.model,executable:t.executable}])).values()]);
const visibleTopics=computed(()=>topics.value.filter(t=>(t.ownerId||t.agentName)===agentId.value));
const currentTopic=computed(()=>topics.value.find(t=>t.key===selected.value));
const keyAllowed=computed(()=>Boolean(isSecureContext&&server.value?.credentialExchangeAllowed));
const errors={PAIR_REQUIRED:'输入你的 Key 连接会话',HTTPS_REQUIRED:'当前入口尚未启用 HTTPS，不能提交 Key',SERVER_NOT_APPROVED:'此地址尚未由服务端批准，请使用已获授权的服务器',PROTECTED_HOST_NOT_READY:'安全链路或服务端接入尚未就绪，暂不接收访问凭据',AUTH_FAILED:'访问凭据不正确',AUTH_RATE_LIMIT:'尝试过于频繁，请稍后重试',AGENT_NOT_EXECUTABLE:'此 Agent 尚未配置服务端执行能力',EXECUTION_INTERRUPTED_REVIEW_REQUIRED:'执行曾被中断，需确认工具副作用后另行发起，系统不会自动重跑'};
async function api(route,body){
 const r=await fetch('/mobile/api/'+route,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const result=await r.json();if(!r.ok){if(r.status===401&&result.error?.code==='PAIR_REQUIRED')paired.value=false;throw Error(errors[result.error?.code]||'请求未完成，请检查连接');}return result;
}
function resetHistory(){generation++;historyKey='';cursor=0;historyRows=new Map();messages.value=[];jobs.value=[];lastSubmission=null;}
async function session(){try{const r=await api('session');paired.value=true;online.value=true;server.value=r.server||server.value;serverUrl.value=r.server?.serverUrl||serverUrl.value;topics.value=r.topics;const existing=topics.value.find(t=>t.key===(r.selectedTopic||selected.value));if(existing){agentId.value=existing.ownerId||existing.agentName;selected.value=existing.key;}else{agentId.value=agents.value[0]?.id||'';selected.value=visibleTopics.value[0]?.key||'';resetHistory();}await refresh();}catch(e){notice.value=e.message;}}
async function pair(){busy.value=true;try{await api('pair',{code:pairCode.value});pairCode.value='';await session();settingsOpen.value=false;}catch(e){notice.value=e.message;}finally{busy.value=false;}}
async function connectionInfo(){try{server.value=await api('connection');serverUrl.value=server.value.serverUrl||server.value.suggestedServerUrl||'';online.value=true;if(keyAllowed.value){server.value=await api('connection/test',{serverUrl:serverUrl.value});tested.value=true;}}catch{notice.value='安全连接尚未就绪，尚未提交任何凭据';}}
async function testConnection(){busy.value=true;tested.value=false;accessKey.value='';try{server.value=await api('connection/test',{serverUrl:serverUrl.value});tested.value=true;notice.value='服务器身份和受保护接入已确认';}catch(e){notice.value=e.message;}finally{busy.value=false;}}
async function connect(){if(!keyAllowed.value||!tested.value)return;busy.value=true;const key=accessKey.value;accessKey.value='';try{await api('connection/authenticate',{serverUrl:serverUrl.value,apiKey:key});resetHistory();await session();settingsOpen.value=false;notice.value='已保存服务器连接，使用受限设备会话';}catch(e){notice.value=e.message;}finally{busy.value=false;}}
async function disconnect(){busy.value=true;accessKey.value='';try{await api('connection/disconnect',{});paired.value=false;topics.value=[];resetHistory();tested.value=false;settingsOpen.value=true;notice.value='此设备会话已撤销，可重新认证';}catch(e){notice.value=e.message;}finally{busy.value=false;}}
function selectAgent(){selected.value=visibleTopics.value[0]?.key||'';changeTopic();}
async function changeTopic(){resetHistory();try{await api('selection',{key:selected.value});await refresh();}catch(e){notice.value=e.message;}}
async function refresh(){
 if(!paired.value||!selected.value||refreshing)return;refreshing=true;const key=selected.value,epoch=generation;
 const stick=historyKey!==key||!history.value||history.value.scrollHeight-history.value.scrollTop-history.value.clientHeight<80;
 try{if(historyKey!==key){historyRows=new Map();cursor=0;historyKey=key;}let result;do{result=await api('conversations/'+encodeURIComponent(key)+'?after='+cursor);if(selected.value!==key||epoch!==generation)return;for(const row of result.messages){if(row.deleted)historyRows.delete(row.id);else historyRows.set(row.id,row.message);}cursor=result.next;}while(result.hasMore);
  messages.value=[...historyRows.values()].sort((a,b)=>a.timestamp-b.timestamp);jobs.value=result.executions;online.value=true;if(currentTopic.value){currentTopic.value.messageCount=messages.value.length;if(result.topicState)Object.assign(currentTopic.value,result.topicState);}
  if(!busy.value)notice.value='中央会话已更新';await nextTick();if(stick&&history.value)history.value.scrollTop=history.value.scrollHeight;
 }catch(e){online.value=false;notice.value=e.message||'连接中断，重新连接后恢复状态';}finally{refreshing=false;}
}
async function submit(submission){
 busy.value=true;notice.value='正在提交…';const key=selected.value;lastSubmission={key,body:submission};
 try{const accepted=await api('conversations/'+encodeURIComponent(key)+'/messages',submission);notice.value='已持久接受 · '+(labels[accepted.state]||accepted.state);text.value='';await refresh();}catch(e){notice.value='尚未确认接受，可重试同一次提交：'+e.message;}finally{busy.value=false;}
}
function send(){if(!text.value.trim()||busy.value||currentTopic.value?.executable===false)return;submit({requestId:crypto.randomUUID(),text:text.value});}
function retry(){
 const latest=[...jobs.value].reverse().find(j=>j.own&&j.state!=='cancelled');const original=latest&&messages.value.find(m=>m.id===latest.userMessageId);
 const submission=lastSubmission?.key===selected.value?lastSubmission.body:(original?{requestId:latest.requestId,text:original.content}:null);if(submission&&!busy.value)submit(submission);
}
async function cancel(id){try{await api('executions/'+id+'/cancel',{});await refresh();}catch(e){notice.value=e.message;}}
function clearTransientKey(){accessKey.value='';pairCode.value='';}
onMounted(async()=>{await connectionInfo();await session();timer=setInterval(refresh,2000);window.addEventListener('pagehide',clearTransientKey);});
onUnmounted(()=>{clearInterval(timer);window.removeEventListener('pagehide',clearTransientKey);clearTransientKey();});
</script>
<template>
 <div class="shell">
  <header><img :src="'/mobile/icon.svg'" alt=""><div><strong>VCP Mobile</strong><small>同一段会话，随时接续</small></div><span class="connection" :class="{offline:!online}">{{online?(paired?'已连接':'服务可达'):'离线'}}</span><button id="open-settings" class="settings-toggle" @click="settingsOpen=!settingsOpen">设置</button></header>
  <main v-if="settingsOpen||!paired" class="pairing settings">
   <div class="intro">连接你的会话</div><p>输入 VCPToolBox API Key。服务器和连接参数已自动配置。</p>
   <form @submit.prevent="connect">
    <details :open="settingsOpen"><summary>连接设置</summary><label for="server-address">后端地址</label><input id="server-address" v-model="serverUrl" type="url" required @input="tested=false;accessKey=''" :disabled="busy">
    <button id="test-connection" type="button" @click="testConnection" :disabled="busy">测试连接</button>
    <p v-if="server" id="server-info">{{server.service}} · {{server.plugin}}<br>{{server.serverUrl||'尚未配置正式后端'}}</p></details>
    <p v-if="!keyAllowed" id="connection-blocker">安全接入尚未确认，访问凭据输入暂不可用。</p>
    <label for="server-key">访问凭据 · VCPToolBox API Key</label><input id="server-key" v-model="accessKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="busy||!keyAllowed||!tested" :placeholder="keyAllowed&&tested?'只需输入你的 Key':'HTTPS 安全入口就绪后可输入'" :required="keyAllowed&&tested">
    <button id="save-connection" :disabled="busy||!tested||!keyAllowed||!accessKey">{{paired?'重新认证并保存连接':'保存服务器连接'}}</button>
   </form>
   <div v-if="paired" class="device-actions"><button id="disconnect" @click="disconnect" :disabled="busy">断开连接</button><button id="clear-session" @click="disconnect" :disabled="busy">清除设备会话</button><button id="close-settings" @click="settingsOpen=false">返回会话</button></div>
   <details v-if="!paired"><summary>使用一次性配对码</summary><form @submit.prevent="pair"><label for="pair-code">一次性配对码</label><input id="pair-code" v-model="pairCode" type="password" autocomplete="off" required><button id="pair-submit" :disabled="busy">连接会话</button></form></details>
   <p role="status">{{notice}}</p>
  </main>
  <template v-else>
   <nav><div class="agent-heading"><img v-if="agents.find(a=>a.id===agentId)?.avatar" :src="agents.find(a=>a.id===agentId).avatar" alt="Agent 头像"><div><label for="agent-select">Agent</label><select id="agent-select" v-model="agentId" @change="selectAgent" :disabled="busy"><option v-for="a in agents" :key="a.id" :value="a.id">{{a.name}}</option></select></div></div><label for="topic-select">历史话题</label><select id="topic-select" v-model="selected" @change="changeTopic" :disabled="busy"><option v-for="t in visibleTopics" :key="t.key" :value="t.key">{{t.topicName}} · {{t.messageCount}} 条</option></select><small v-if="currentTopic" class="topic-detail">{{currentTopic.topicId}} · {{currentTopic.model||'未配置模型'}} · {{currentTopic.historyReady===false?'等待电脑首次同步':currentTopic.executable===false?'仅可阅读':'可继续对话'}}<template v-if="currentTopic.updatedAt"> · {{new Date(currentTopic.updatedAt).toLocaleString()}}</template></small></nav>
   <section ref="history" id="history" aria-label="聊天历史"><div class="start">文本会话 · 服务端持久保存</div><article v-for="m in messages" :key="m.id" class="message" :class="m.role" :data-message-id="m.id"><small>{{m.role==='user'?'你':(m.name||currentTopic?.agentName||'Agent')}}</small><div class="bubble">{{typeof m.content==='string'?m.content:'此消息包含非文本内容，请在桌面查看'}}</div></article><p v-if="!messages.length" class="empty">{{currentTopic?.historyReady===false?'正在等待电脑同步所选历史，完成后即可接续。':'还没有消息，发送一条开始会话。'}}</p></section>
   <section class="executions" aria-label="执行状态"><div v-for="j in jobs" :key="j.id" class="execution-row" :data-exec-id="j.id" :data-state="j.state"><span>{{j.errorCode==='EXECUTION_INTERRUPTED_REVIEW_REQUIRED'?errors[j.errorCode]:(labels[j.state]||j.state)}}</span><button v-if="j.own&&['queued','running'].includes(j.state)" :data-cancel-id="j.id" @click="cancel(j.id)">取消</button></div></section>
   <footer><form @submit.prevent="send"><label class="sr-only" for="message-text">消息</label><textarea id="message-text" v-model="text" placeholder="输入文字…" rows="2" maxlength="12000" :disabled="currentTopic?.executable===false"></textarea><button id="send" :disabled="busy||!text.trim()||currentTopic?.executable===false">发送</button></form><div class="send-state"><span id="send-state" role="status">{{notice}}</span><button id="retry-last" @click="retry" :disabled="busy">核对 / 重试提交</button></div></footer>
  </template>
 </div>
</template>
