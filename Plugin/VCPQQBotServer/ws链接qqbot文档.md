事件订阅与通知
说明

当用户在QQ平台内的一些行为操作或某些接口的有异步返回通知确认机制的场景的时候，QQ 会通过"事件"的方式，通知到开发者服务器，开发者可自行根据具体事件通知来进行下一步响应。譬如用户跟机器人发消息，用户添加机器人好友，机器人被拉入群聊等等事件。

#通用数据结构 Payload
payload 指的是在 webhook或websocket 连接上传输的数据，网关的上下行消息采用的都是同一个结构，如下：

{
  "id":"event_id",
  "op": 0,
  "d": {},
  "s": 42,
  "t": "GATEWAY_EVENT_NAME"
}
字段	描述
id	事件id
op	指的是 opcode，参考连接维护
s	下行消息都会有一个序列号，标识消息的唯一性，客户端需要再发送心跳的时候，携带客户端收到的最新的s
t	代表事件类型。主要用在op为 0 Dispatch 的时候
d	代表事件内容，不同事件类型的事件内容格式都不同，请注意识别。主要用在op为 0 Dispatch 的时候
#OpCode 含义
所有 opcode 列表如下：

CODE	名称	接入方式	客户端行为	描述
0	Dispatch	webhook/websocket	Receive	服务端进行消息推送
1	Heartbeat	websocket	Send/Receive	客户端或服务端发送心跳
2	Identify	websocket	Send	客户端发送鉴权
6	Resume	websocket	Send	客户端恢复连接
7	Reconnect	websocket	Receive	服务端通知客户端重新连接
9	Invalid Session	websocket	Receive	当 identify 或 resume 的时候，如果参数有错，服务端会返回该消息
10	Hello	websocket	Receive	当客户端与网关建立 ws 连接之后，网关下发的第一条消息
11	Heartbeat ACK	websocket	Receive/Reply	当发送心跳成功之后，就会收到该消息
12	HTTP Callback ACK	webhook	Reply	仅用于 http 回调模式的回包，代表机器人收到了平台推送的数据
13	回调地址验证	webhook	Receive	开放平台对机器人服务端进行验证
客户端行为含义如下：

Receive 客户端接收到服务端 push 的消息

Send 客户端发送消息

Reply 客户端接收到服务端发送的消息之后的回包（HTTP 回调模式）

#Webhook方式
QQ机器人开放平台支持通过使用HTTP接口接收事件。开发者可通过管理端 (opens new window)设定回调地址，监听事件等。

目前回调地址允许配置的端口号为： 80、443、8080、8443。

#签名校验
机器人服务端需要对回调请求进行签名验证以保证数据没有被篡改过。 签名算法

#回调地址及事件监听配置
开发者需要提供一个HTTPS回调地址。并选定监听的事件类型。开放平台会将事件通过回调的方式推送给机器人。

event_subscription
配置回调地址后，开放平台会对回调地址进行验证：

请求结构(Payload.d)
字段	描述
plain_token	需要计算签名的字符串
event_ts	计算签名使用时间戳
返回结果
字段	描述
plain_token	需要计算签名的字符串
signature	签名
计算过程如下(golang)：

func handleValidation(rw http.ResponseWriter, r *http.Request, botSecret string) {
	httpBody, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println("read http body err", err)
		return
	}
	payload := &Payload{}
	if err = json.Unmarshal(httpBody, payload); err != nil {
		log.Println("parse http payload err", err)
		return
	}
	validationPayload := &ValidationRequest{}
	if 	err = json.Unmarshal(payload.Data, validationPayload);err != nil {
		log.Println("parse http payload failed:", err)
		return
	}
	seed := botSecret
	for len(seed) < ed25519.SeedSize {
		seed = strings.Repeat(seed, 2)
	}
	seed = seed[:ed25519.SeedSize]
	reader := strings.NewReader(seed)
	// GenerateKey 方法会返回公钥、私钥，这里只需要私钥进行签名生成不需要返回公钥
	_, privateKey, err := ed25519.GenerateKey(reader)
	if err != nil {
		log.Println("ed25519 generate key failed:", err)
		return
	}
	var msg bytes.Buffer
	msg.WriteString(validationPayload.EventTs)
	msg.WriteString(validationPayload.PlainToken)
	signature := hex.EncodeToString(ed25519.Sign(privateKey, msg.Bytes()))
	if err != nil {
		log.Println("generate signature failed:", err)
		return
	}
	rspBytes, err := json.Marshal(
		&ValidationResponse{
			PlainToken: validationPayload.PlainToken,
			Signature:  signature,
		})
	if err != nil {
		log.Println("handle validation failed:", err)
		return
	}
	rw.Write(rspBytes)
}

例如机器人账号

appid: 11111111
secret: DG5g3B4j9X2KOErG
回调验证请求：

headers: User-Agent:[QQBot-Callback] X-Bot-Appid:[11111111]
body: {"d":{"plain_token":"Arq0D5A61EgUu4OxUvOp","event_ts":"1725442341"},"op":13},
机器人应返回：

body: {"plain_token": "Arq0D5A61EgUu4OxUvOp","signature": "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706"}
#WebSocket方式
#发起连接到 Gateway
第一步先调用 获取通用WSS 接入点 | QQ机器人文档 或 获取带分片WSS 接入点 | QQ机器人文档 接口获取网关地址。

会得到一个类似下面这样的地址：

wss://api.sgroup.qq.com/websocket/
然后进行 websocket 长连接建立，一旦连接成功，就会返回 OpCode 10 Hello 消息。这个消息主要的内容是心跳周期，单位毫秒(milliseconds)，如下：

{
  "op": 10,
  "d": {
    "heartbeat_interval": 45000
  }
}
#登录鉴权获得 Session
websocket 长连接建立之后，需要进行登录鉴权，登录鉴权成功后会获得一个 session 会话 id，只有登录成功后，QQ后台才会下发事件通知，

发送一个 OpCode 2 Identify 消息， payload 如下：

{
  "op": 2,
  "d": {
    "token": "token string",
    "intents": 513,
    "shard": [0, 4],
    "properties": {
      "$os": "linux",
      "$browser": "my_library",
      "$device": "my_library"
    }
  }
}

字段	描述
token	格式为"QQBot {AccessToken}"
intents	是此次连接所需要接收的事件，具体可参考 Intents [事件订阅intents\
shard	考虑到开发者事件接收时可以实现负载均衡，QQ 提供了分片逻辑，事件通知会落在不同的分片上，该参数是个拥有两个元素的数组。
例如：[0,4]，代表分为四个片，当前链接是第 0 个片，业务稍后应该继续建立 shard 为[1,4],[2,4],[3,4]的链接，才能完整接收事件，更多详细的内容可以参考 Shard [Shard机制\
properties	目前无实际作用，可以按照自己的实际情况填写，也可以留空
鉴权成功之后，QQ 后台会下发一个 Ready Event， payload 如下：

{
  "op": 0,
  "s": 1,
  "t": "READY",
  "d": {
    "version": 1,
    "session_id": "082ee18c-0be3-491b-9d8b-fbd95c51673a",
    "user": {
      "id": "6158788878435714165",
      "username": "群pro测试机器人",
      "bot": true
    },
    "shard": [0, 0]
  }
}
#发送心跳 Ack
鉴权成功之后，就需要按照周期进行心跳发送。d 为客户端收到的最新的消息的 s，如果是首次连接，d 为传 null， payload 如下：

{
  "op": 1,
  "d": 251
}
心跳发送成功之后会收到 OpCode 11 Heartbeat ACK 消息， payload 如下：

{
  "op": 11
}
#恢复登录态 Session
有很多原因可能会导致 websocket 长连接断开，断开之后短时间内重连会补发中间遗漏的事件，以保障业务逻辑的正确性。断开重连 gateway 后不需要发送重新登录 Opcode 2 Identify请求。在连接到 Gateway 之后，需要发送 Opcode 6 Resume消息， payload 如下：

{
  "op": 6,
  "d": {
    "token": "my_token",
    "session_id": "session_id_i_stored",
    "seq": 1337
  }
}
其中 seq 指的是在接收事件时候的 s 字段，我们推荐开发者在处理过事件之后记录下 s 这样可以在 resume 的时候传递给 websocket， websocket 会自动补发这个 seq 之后的事件。

恢复成功之后，就开始补发遗漏事件，所有事件补发完成之后，会下发一个 Resumed Event， payload 如下：

{
  "op": 0,
  "s": 2002,
  "t": "RESUMED",
  "d": ""
}
#事件订阅Intents
事件的 intents 是一个标记位，每一位都代表不同的事件，如果需要接收某类事件，就将该位置为 1。

每个 intents 位代表的是一类事件，可以使用使用 websocket 传输的数据中的 t 字段的值来区分。

事件和位移的关系如下：

GUILDS (1 << 0)
  - GUILD_CREATE           // 当机器人加入新guild时
  - GUILD_UPDATE           // 当guild资料发生变更时
  - GUILD_DELETE           // 当机器人退出guild时
  - CHANNEL_CREATE         // 当channel被创建时
  - CHANNEL_UPDATE         // 当channel被更新时
  - CHANNEL_DELETE         // 当channel被删除时

GUILD_MEMBERS (1 << 1)
  - GUILD_MEMBER_ADD       // 当成员加入时
  - GUILD_MEMBER_UPDATE    // 当成员资料变更时
  - GUILD_MEMBER_REMOVE    // 当成员被移除时

GUILD_MESSAGES (1 << 9)    // 消息事件，仅 *私域* 机器人能够设置此 intents。
  - MESSAGE_CREATE         // 发送消息事件，代表频道内的全部消息，而不只是 at 机器人的消息。内容与 AT_MESSAGE_CREATE 相同
  - MESSAGE_DELETE         // 删除（撤回）消息事件

GUILD_MESSAGE_REACTIONS (1 << 10)
  - MESSAGE_REACTION_ADD    // 为消息添加表情表态
  - MESSAGE_REACTION_REMOVE // 为消息删除表情表态

DIRECT_MESSAGE (1 << 12)
  - DIRECT_MESSAGE_CREATE   // 当收到用户发给机器人的私信消息时
  - DIRECT_MESSAGE_DELETE   // 删除（撤回）消息事件


GROUP_AND_C2C_EVENT (1 << 25)
  - C2C_MESSAGE_CREATE      // 用户单聊发消息给机器人时候
  - FRIEND_ADD              // 用户添加使用机器人
  - FRIEND_DEL              // 用户删除机器人
  - C2C_MSG_REJECT          // 用户在机器人资料卡手动关闭"主动消息"推送
  - C2C_MSG_RECEIVE         // 用户在机器人资料卡手动开启"主动消息"推送开关
  - GROUP_AT_MESSAGE_CREATE // 用户在群里@机器人时收到的消息
  - GROUP_ADD_ROBOT         // 机器人被添加到群聊
  - GROUP_DEL_ROBOT         // 机器人被移出群聊
  - GROUP_MSG_REJECT        // 群管理员主动在机器人资料页操作关闭通知
  - GROUP_MSG_RECEIVE       // 群管理员主动在机器人资料页操作开启通知

INTERACTION (1 << 26)
  - INTERACTION_CREATE     // 互动事件创建时

MESSAGE_AUDIT (1 << 27)
  - MESSAGE_AUDIT_PASS     // 消息审核通过
  - MESSAGE_AUDIT_REJECT   // 消息审核不通过

FORUMS_EVENT (1 << 28)  // 论坛事件，仅 *私域* 机器人能够设置此 intents。
  - FORUM_THREAD_CREATE     // 当用户创建主题时
  - FORUM_THREAD_UPDATE     // 当用户更新主题时
  - FORUM_THREAD_DELETE     // 当用户删除主题时
  - FORUM_POST_CREATE       // 当用户创建帖子时
  - FORUM_POST_DELETE       // 当用户删除帖子时
  - FORUM_REPLY_CREATE      // 当用户回复评论时
  - FORUM_REPLY_DELETE      // 当用户回复评论时
  - FORUM_PUBLISH_AUDIT_RESULT      // 当用户发表审核通过时

AUDIO_ACTION (1 << 29)
  - AUDIO_START             // 音频开始播放时
  - AUDIO_FINISH            // 音频播放结束时
  - AUDIO_ON_MIC            // 上麦时
  - AUDIO_OFF_MIC           // 下麦时

PUBLIC_GUILD_MESSAGES (1 << 30) // 消息事件，此为公域的消息事件
  - AT_MESSAGE_CREATE       // 当收到@机器人的消息时
  - PUBLIC_MESSAGE_DELETE   // 当频道的消息被删除时
#举例
如开发者需要接收用户 at 机器人的消息，那么就需要在 intents 中设置接收 PUBLIC_GUILD_MESSAGES。则需要先计算 1 << 30 的值。然后与 0 做位或操作，得到最终需要传递的 intents。

如果涉及到多个事件类型的接收，则需要将多个结果做位或操作，如：0|1<<30|1<<1 代表订阅 PUBLIC_GUILD_MESSAGES 和 GUILD_MEMBERS 这两类事件。

#权限
事件类型的订阅，是有权限控制的，除了 GUILDS，PUBLIC_GUILD_MESSAGES，GUILD_MEMBERS 事件是基础的事件，默认有权限订阅之外，其他的特殊事件，都需要经过申请才能够使用，如果在鉴权的时候传递了无权限的 intents， websocket 会报错，并直接关闭连接。请开发者注意订阅事件的范围需要控制在自己所需要的范围之内。

如果拥有的某个特殊事件类型的权限被取消，则在当前连接上不会报错，但是将不会收到对应的事件类型，如果重新连接，则报错，所以如果开发者的事件类型权限被取消，请及时调整监听事件代码，避免报错导致的无法连接。

#分片连接LoadBalance
随着bot的增长并被添加到越来越多的频道中，事件越来越多，业务有必要对事件进行水平分割，实现负载均衡。机器人网关实现了一种用户可控制的分片方法，该方法允许跨多个网关连接拆分事件。 分片完全由用户控制，并且不需要在单独的连接之间进行状态共享。

要在连接上启用分片，需要在建立连接的时候指定分片参数，具体参考gateway

#获得合适的分片数
使用/gateway/bot接口获取网关地址的时候，会同时返回一个建议的 shard数，及最大并发限制。

{
  "url": "wss://sandbox.api.sgroup.qq.com/websocket",
  "shards": 1,
  "session_start_limit": {
    "total": 1000,
    "remaining": 1000,
    "reset_after": 86400000,
    "max_concurrency": 1
  }
}
#分片规则
分片是按照频道id进行哈希的，同一个频道的信息会固定从同一个链接推送。具体哈希计算规则如下：

shard_id = (guild_id >> 22) % num_shards
#最大连接数
每个机器人创建的连接数不能超过remaining剩余连接数