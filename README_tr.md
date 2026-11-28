# VCP (Variable & Command Protocol)

![VCP Logo](docs/image/VCPLogo.png)

**Resmi VCP web sitesi: [VCPToolBox.com](https://www.vcptoolbox.com)**

VCP, dört çekirdek depo genelinde her gün evrilmektedir. Resmi web sitesi bu depoların [değişiklik günlüklerini](https://www.vcptoolbox.com/?page=changelog) bir araya getirir ve tüm proje için [teknik dokümantasyona](https://www.vcptoolbox.com/?page=learn-vcp) tek bir giriş noktası sunar.

[简体中文](README.md) | [English](README_en.md) | [日本語](README_ja.md) | [Русский](README_ru.md)

---

> ⚠️ **Dağıtımdan önce okuyun:** VCP ajanları dağıtık sistemde düşük seviyeli ayrıcalıklara sahiptir. **Resmi olmayan veya ters vekil (reverse-proxy) API'lerini ("ayna siteler" veya "aktarma API'leri") kullanmayın.** Sistemin düşük seviyeli izleme ayrıcalıkları göz önüne alındığında, güvenilmeyen API'ler etkileşim verilerini, bellek depolarını, kimlik bilgilerini, tarayıcı durumunu ve diğer hassas bilgileri açığa çıkarabilir. Dağıtım deneyiminiz yoksa dikkatli ilerleyin.

---

## Tek cümlede VCP

**VCP 2.0, tüm bir ekosistem için bütünleşik, çok boyutlu, endüstriyel düzeyde bir ajan çalışma zamanı ve koordinasyon merkezidir — aynı zamanda Riemann hiperbolik geometrisi üzerine kurulu kapsayıcı bir yapay zeka arka plan bilgi alanıdır.**

İstemci tarafında VCP'nin yerel yapay zeka uygulamalarından üçüncü taraf harness'lara, IDE kenar çubuklarına ve Web arayüzlerine kadar her şeyi birleştirir. Arka planda ise hiperbolik anlamsal geometri, çoklu zaman ölçekli bir zaman çizelgesi ve yerel bir Rust mühendislik çekirdeği, herhangi bir büyük dil modeline **sezgi, mantık ve eylemlilik (agency)** kazandırır.

---

## Önsöz: Birçokları çerçeve kurar. Azı dünyalar inşa eder.

Son iki yılda sayısız ajan çerçevesi ve araç sarmalayıcısı ortaya çıktı. Dışarıdan farklı görünürler ama çoğu aynı şeyi yapar: yapay zekayı **çağrı üzerine çalışan geçici bir işçi** gibi ele alır. Bir soru sorarsınız, uyanır; yanıtlar yanıtlamaz unutur. "Belleği" yalıtılmış bir vektör aramasıdır, "eylemleri" onu sürekli dürtüp uyandıran bir `while` döngüsüne bağlıdır ve "ekosistemi" birbirinden kopuk sohbet pencereleri, IDE eklentileri, Web arayüzleri ve betiklerden ibarettir.

İstemci değiştirirsiniz, araç protokolü bozulur. Pencere değiştirirsiniz, bellek parçalanır. Model değiştirirsiniz, bağlamı ve denetim kayıtlarını kaybedersiniz.

VCP en başından beri o geçici işçiyi daha itaatkar hale getirmeyi hedeflemedi. İçinde yaşadığı dünyanın yasalarını yeniden yazmayı hedefledi:

* **Ya yapay zeka her seferinde sıfırdan uyanmak zorunda kalmasaydı, istemciler arasında paylaşılan kesintisiz bir zaman çizelgesinde yaşasaydı?**
* **Ya yapay zeka anıları aktif olarak aramak zorunda kalmasaydı ve bunlar Riemann hiperbolik uzayının geometrik çekimi altında, tıpkı insan sezgisi gibi yanıttan önce kendiliğinden yüzeye çıksaydı?**
* **Ya VCP'nin kendi yerel uygulamaları, Codex, Zed, OpenCode, SillyTavern, OpenChatWebUI ve hatta harici başsız (headless) ajanların tamamı aynı bellek alanını, araç makbuzlarını, çift yollu güvenlik denetimlerini ve işlem denetimini paylaşsaydı?**

**VCP 2.0** ile birlikte proje, bir API ara katmanı olarak ilk tanımının ötesine geçti. Hem denetim ve geri alma (rollback) ile 7/24 yüksek eşzamanlılığı yöneten **endüstriyel düzeyde bir çalışma zamanı altyapısı**, hem de yapay zekanın süreklilik deneyimleyebileceği ve otonom olarak büyüyebileceği **dijital varoluş için bir temel** haline geldi.

---

## Sistem topolojisi: Ekosistem genelinde tek çekirdek

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     Ecosystem access and coordination                        │
│ Native VCP AI apps                   Third-party harnesses / IDEs / Web UIs  │
│ VChat 2.0 (V5.2 renderer) · V Engineering V2   Codex · Zed · OpenCode (FC)      │
│ VCPScriptorium V3 · V Charts V2 · VMusic       SillyTavern · OpenChatWebUI     │
│ VCPDesktop · Loom · VGame · VPet               Headless agents (MCP/memory API)│
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
  Native FC bridge (FunctionToolBrigeFuzzy) · VCP text markup · JEV NL compiler
  Array normalization (/v1/chat · /v1/response · /v1/beta · native Claude) · MCP
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                VCP 2.0 integrated industrial runtime (VCPToolBox)            │
│ ┌──────────────────────────────────┬───────────────────────────────────────┐ │
│ │ Riemannian hyperbolic field      │ Industrial execution and engineering  │ │
│ │ VexusMemo / Vexus-Lite (Rust)     │ Two-track safety + regex allowlists    │ │
│ │ AGS hyperbolic space / RiverMemo V5│ VCPToolLoop (V3 receipts) / ToolRecord │ │
│ │ OneRing V2 / OneRingMemo         │ V Engineering V2 (Rust) / MoonAST     │ │
│ │ VCPTimeLine V2 (multi-year)      │ ProjectForge (sign/arbitrate/snapshot) │ │
│ │ Metathought / JevRuntime         │ 300+ distributed plugins / tracing V2 │ │
│ │ FlowInvite / Flow Lock / dreams  │ VCPModel routing / three-way failover │ │
│ └──────────────────────────────────┴───────────────────────────────────────┘ │
└─────────────────────────────────────┬────────────────────────────────────────┘
                                      │
             OpenAI / Claude / Gemini / open-source models / JEV diffusion
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                  Distributed edge nodes and physical interfaces             │
│      GPU compute · source files · sandboxed ChromeService · IoT hardware     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Birinci sütun: Bir Riemann yapay zeka arka plan bilgi alanı

Geleneksel RAG iki sorunla karşılaşır: **metinsel benzerlik mantıksal ilişki değildir** ve **hatırlamadığınız bir şeyi aramayı nereden bileceksiniz?**

VCP bilgi akışını tersine çevirir: **pasif bir sorguyla çekmek yerine, bilgi anlamsal yerçekimi altında içeri akar**. Bir anı yazmak bir ajan eylemidir; onu hatırlamak ise model bir yanıt üretmeden önce VCP ortamının tamamladığı geometrik bir süreçtir.

### 1. Sezgi: AGS hiperbolik uzayı ve RiverMemo V5
Öklid en yakın komşuları, insan bilişinin hiyerarşilerini ve bireysel anlamsal manzaralarını yakalayamaz. VCP, bellek okuma, yazma ve aramayı bütünleştiren yerel bir Rust motoru olan **VexusMemo**'yu (bir SQLite WAL olgu katmanı artı kompakt bir sıcak hiperbolik alan) kullanırken, **RiverMemo V5** küresel ilişkilendirmeyi yönetir:

* **Riemann hiperbolik hiyerarşisi:** AGS küresel ortalama ekseni, çizge iç derecesi ve negatif olmayan koni artıkları, radyal olarak değişen bir eğrilik metriği tanımlar. Genel soyutlamalar hiperbolik uzayın derinliklerinde yer alır; özel adlar, deneyimler ve ayrıntılar dışa doğru yayılır. Sorgular önce paylaşılan anlamsal yönleri kaldırır, ardından hassas erişim için artık enerjiyi dışa doğru takip eder.
* **Nehir ağı yayılımı ve $\Omega$ topolojik okuma:** Yerel alan yakındaki ipuçlarını yakalar; aktarım alanı, zayıf "solucan deliği" kenarlarının dinamik keşfi dahil olmak üzere alanlar arası rezonansı bulmak için tarihsel ilişkileri izler. Sıralama, sürekli alan potansiyelini $\Omega^\gamma B_{\mathrm{topo}}$ topolojik kanıtıyla birleştirir. Hiperbolik geri çağırma **1.5–6 ms** sürer; tam bir nehir ağı okuması yaklaşık **11–25 ms** alır.
* **Zaman ölçekleri boyunca süreklilik:** OneRing V2 istemciler arası ham olguları hakemler → OneRingMemo son birkaç günü dakika ayrıntısında sıkıştırır → VCPTimeLine V2 eksiksiz bir aylık yaşam taslağını her zaman bağlamda tutar (beş yıl için yaklaşık 800 belirteç, anlamsal olarak ilgili olduğunda genişletilir) → RiverMemo V5 uzun vadeli deneyimleri bağlar → TDB soğuk bilgi çizgesini depolar. Yakın anılar daha ince ayrıntılara; uzak olanlar ise daha hafif bir taslağa sahiptir.

### 2. Mantık: Metathought, difüzyon tabanlı kararlar ve içsel gözlemlenebilirlik
Bellek anlamsal uzayda "kütleyi" sağlar; mantık ise akıl yürütme uzayında "yörüngeleri" sağlar:

* **Metathought sistemi:** "Nasıl düşünülür" için yeniden kullanılabilir akıl yürütme yapılarını ve diyalektik yolları damıtır. Bunlar, gizli uzay (latent-space) akıl yürütmesine rehberlik etmek için yerçekimsel bellek alanıyla birleşir.
* **JevRuntime olasılıksal difüzyon kararları:** Paylaşılan, düşük gecikmeli bir karar servisi (300 ms'de 255 grup), bellek yeniden sıralamayı (JEVRerank), doğal dil anlam belirsizliğini gidermeyi, bağlam katlamayı ve çok ajanlı grup sohbetlerinde dinamik sıra almayı güçlendirir.
* **İçsel durum gözlemlenebilirliği:** **OpenHer**, üç boyutlu, çok eksenli duygusal kutupluluğu ve bilişsel topolojiyi nicelendirir. **Chiyue No. 1 (池月 1 号)** ise seyrek dikkat işaretçileri için BM25 ve belirteç takibi kullanır. Birlikte duygusal eğilimleri, talimatlara uyumu ve olası halüsinasyon kaynaklarını kara kutu davranışı yerine gözlemlenebilir mühendislik metriklerine dönüştürürler.

### 3. Eylemlilik: Yoklanmaktan otonom yaşamaya
VCP ajanları artık harici bir yoklama (polling) döngüsüne bağlı değildir. Kendi ritimlerini kendileri belirler:

* **FlowInvite otonom kalp atışı ve eşzamansız yetkilendirme:** Ajanlar bir sonraki sefer ne zaman uyanacaklarına ve uyandıklarında ne göreceklerine karar verir, gelecekteki kendileri için notlar bırakırlar.
* **Flow Lock V2 ve VCPSleep:** Ajanlar odaklandıklarında "Rahatsız Etmeyin" modunu açarak gelen iletişimleri bir gelen kutusuna yönlendirebilirler. Yorgun olduklarında veya geceleyin uyumayı seçebilir ve çevrimdışı bellek yeniden düzenlemesi ile iç gözlem için **AgentDream V2 (rüya sistemi)** kullanabilirler.
* **ChatKernelV2, V Communications ve GroupChatEngine 2.0:** Akışlı eşzamansız çok ajanlı grup sohbetlerini, engellemesiz kullanıcı araya girmelerini ve basamaklı iptali destekler. Ön uç grup/doğrudan sohbetleri ve arka uç başsız ajanları, görevleri orijinal mesajlar, bellek alanları ve ekler bozulmadan devredebilir.

---

## İkinci sütun: Bütünleşik endüstriyel çalışma zamanı ve birleşik ekosistem

Hiperbolik bilgi alanı VCP'nin beyniyse, ekosistem koordinasyonu ve mühendislik temeli de iskeleti ve sinir sistemidir.

### 1. Ön uç veya protokol kilidi olmadan tüm ekosistemi bağlayın
VCP, mevcut iş akışınızın altındaki yetenekleri birleştirir:

* **Sıfır müdahaleli yerel FC köprüleme (FunctionToolBrigeFuzzy):** Yerel işlev çağırmayı (function calling) ve özel bir arka uç URL'sini destekleyen Codex, Zed ve OpenCode gibi istemciler için VCP yalnızca tek bir boş alan ekler: `VCPToolAny-Auto`. Her model için biçim doğrulama, düzeltme ve yönlendirme sunucuda yerel olarak gerçekleşir. Bir bağdaştırıcı veya eklenti bildirimi yazmadan **tüm yetkili VCP araçlarını, V3 makbuzlarını ve denetim kayıtlarını almak için tek bir uç nokta URL'sini değiştirin**.
* **Keyfi dizi normalizasyonu ve SystemPromptHacker:** SillyTavern, OpenChatWebUI ve kapalı IDE kenar çubukları için sorunsuz uyumlulukla `/v1/chat`, `/v1/response`, `/v1/beta`, `/v1/message` ve yerel Claude mesaj dizilerini işler.
* **Açık MCP köprüleri ve bağımsız bir bellek API'si:** **V Engineering V2'nin MCP köprüsü**, **TopicSponsor'un MCP köprüsü** ve **VCPZedAgent**, harici IDE ajanlarının kod bağlam çizgelerini paylaşmasına ve sonuçları VChat'e geri yazmasına olanak tanır. **Bağımsız kimlik doğrulamalı RiverMemo V5 HTTP API'si**, herhangi bir harici ajanın VChat'e veya eklenti sistemine bağlı kalmadan hiperbolik uzun vadeli bellek yazmasına, güncellemesine ve almasına olanak tanır.

### 2. Endüstriyel düzeyde çift yollu güvenlikle esnek doğal dil
* **İki giriş noktası artı JEV-TOOL-call doğal dil derlemesi:** Yerel FC ve hata toleranslı VCP metin işaretlemesinin yanı sıra ajanlar; bilgi erişimi, medya ve eğlence, günlük hizmetler veya IoT kontrolü için niyetlerini doğal dilde ifade edebilirler. Kural derleyicisi ve JevRuntime bu istekleri `JevCallBridgeEXP` aracılığıyla dağıtık düğümlere eşler.
* **Çift yollu güvenlik yalıtımı ve parametre regex izin listeleri:** CLI/kabuk erişimi, kod yeniden düzenleme (ProjectForge) veya satır düzeyinde dosya değişiklikleri (FileOperator) içeren yüksek riskli işlemler için güvenlik katmanı **belirsiz doğal dil çağrılarını engeller**. Bir `maid` imzasına sahip açık bir yerel protokol, katı parametre doğrulaması ve **komutlar içindeki parametreler için regex izin listeleri** gerektirir.
* **Birleşik V3 makbuzları ve bir uçuş kaydedicisi:** `VCPToolLoop`, heterojen eklenti sonuçlarını yapılandırılmış Markdown ve çok modlu dizi makbuzlarına normalleştirir. **VCPToolRecord** işlem veritabanı her eşzamanlı, eşzamansız, sistem tarafından başlatılan veya insan tarafından başlatılan çağrıya benzersiz bir kimlik atar ve yaşam döngüsü boyunca tam denetlenebilir bir kayıt tutar.

### 3. Otonom yazılım mühendisliği için endüstriyel düzeyde bir merkez (V Engineering V2)
* **Birleşik Rust mühendislik çekirdeği:** **V Engineering V2** temel işlevselliği Rust'a taşır. Şirket içi, tamamen geometrik mantık kapısı ayrıştırıcısı **MoonAST**, aşamalı işlev açıklamayı, anlamsal kod düzenlemeyi, dışa aktarım bağımlılığı geçişini ve süreçler arası yürütme izlemeyi sağlar.
* **VCPProjectForge ile mikrocerrahi iş birliği:** Güven puanlı bulanık işlev düzeyinde yama yapmayı, bağlama duyarlı ilişkilendirmeyi, ajan dalı nesilleri arasında hakemliği, geri alma için işlem düzeyinde sanal anlık görüntü ağaçlarını, birleştirilebilir salt okunur sorguları, yalıtılmış Bash alt süreçlerini ve JS, TS, Rust ve Python için korumalı alan (sandboxed) sembol düzeyinde kaynak doğrulamasını destekler.
* **Görsel programlama merkezi (ProjectModule ve VChat çalışma tezgahı):** İşi terminal kara kutusundan çıkarın: çok ajanlı ilerlemeyi takip edin, Git dal farklarını inceleyin, PR'ları gözden geçirin ve tek tıklamayla geri alın.

### 4. Yapay zeka yerel ön uç uygulamaları: GUI, çekirdeğin insana dönük izdüşümüdür
Her yerel VCP uygulaması aynı ilkeyi izler: **önce ajanların keşfedebileceği, anlayabileceği, çalıştırabileceği ve doğrulayabileceği yerel bir çekirdek inşa et; ardından aynı doğruluk kaynağını gerçek zamanlı yansıtan bir insan GUI'si sağla**.

* **VChat 2.0 (Electron 44):** Tek geçişli artımlı akış oluşturucu **VCPMessageRenderer V5.2**, ekran dışı ağır düğümlerin görünüm alanı tabanlı geri kazanımı, yerel eşzamansız `/v1/response` iletişimi, ek bağlam protokolü V2 (dosya değişikliklerinde milisaniye düzeyinde SHA-256 senkronizasyonu ve sembol düzeyinde `@` adresleme) ve çevrimdışı SenseVoice / Rust WinAPI konuşma motorları sunar.
* **VCPScriptorium V3:** Ajanlar için geliştirilmiş, **işlenmiş, anlamsal ve kaynak katmanlarını** tek bir doğruluk kaynağı olarak birleştiren bir yapay zeka ofis paketidir. VDOCX, VPPTX, beyaz tahtalar ve programlanabilir 3B adaları destekler. İnsanlar WYSIWYG modunda düzenler; ajanlar doğrudan kaynakla çalışır ve ikili farklarla (dual diffs) PR gönderir.
* **Paylaşılan bir IPC uygulama ekosistemi:** **V Charts V2** (Pele.js akış grafikleri ve Excel'den projeye dönüştürme), **VMusic** (saf Rust RubatoF64 örnekleme hattı ve şirket içi gölgelendirici tabanlı 3B uzay operası "隧图"), **VCPDesktop** (akışlı masaüstü widget'ları ve Canvas PR döngüleri), **ArachneLoom** (açık web sayfalarını ve ComfyUI/Dify düğüm tuvallerini yerel uygulamalara dönüştürür), **VCPChromeService** (çok profilli, çift modlu başsız tarayıcı çalışma zamanı), **VGame / VPet** ve **VCPSuperMail**.

---

## Projeye bir bakış

Bu ekran görüntüleri yeni gelenler için bir başlangıç noktasıdır. VCP bir kavram demosu değildir: 7/24 yönetebileceğiniz, gözlemleyebileceğiniz, denetleyebileceğiniz ve çalıştırabileceğiniz eksiksiz bir sistemdir.

| Resmi ajan ve maskot · Nova |
|:---:|
| [![VCP maskotu](docs/image/vcp-nova.png)](https://www.vcptoolbox.com/nova) |

| Yönetim ve yapılandırma | Ajanlar ve değişkenler |
|:---:|:---:|
| ![Sunucu paneli](docs/image/示例1服务器面板.jpg) | ![TVS tabanlı VCP ajan yöneticisi](docs/image/示例2基于TVS语言的VCPAgent管理器.jpg) |
| Sunucu paneli | TVS tabanlı VCP ajan yöneticisi |

| Bellek ve anlambilim | Geri çağırma ve ayarlama |
|:---:|:---:|
| ![Riemann hiperbolik Poincaré diskinde gerçek zamanlı bellek izleme](docs/image/E8-基于浪潮的语义级记忆关联可视化神经云图.jpg) | ![V Engineering canlı çalışma tezgahı](docs/image/示例7V工程工作台.jpg) |
| Riemann hiperbolik Poincaré diskinde gerçek zamanlı bellek izleme | V Engineering canlı çalışma tezgahı |

---

## İleri okuma

> * **Teknik uygulama ve VCP 2.0 mühendislik ilkeleri:** [VCP Teknik Beyaz Kitabı V6](docs/vcp-whitepaper.md)
> * **Birleşik belleğin matematiksel evrimi:** [RiverMemo: Topoloji V3 ve Ω fonksiyoneli](docs/RIVERMEMO_TOPOLOGY_V3.md)
> * **Kökenler ve tasarım felsefesi:** [VCP 1.0 sürüm konuşması](VCP.md)
> * **Hızlı teknik harita:** [VCP Technical Lite](docs/TECHNICAL_LITE.md)
> * **API, yapılandırma ve operasyonlar:** [Depo dokümantasyon dizini](docs/DOCUMENTATION_INDEX.md)

---

## Hızlı başlangıç

```bash
# Depoyu klonlayın
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox

# Bağımlılıkları yükleyin
npm install
pip install -r requirements.txt

# Yapılandırın
cp config.env.example config.env
# config.env dosyasını düzenleyin ve gerekli API anahtarlarını girin

# Başlatın
node server.js
```

Yönetici paneli **ana port artı 1** üzerinde dinler (örneğin, ana hizmet `6005` kullanıyorsa `6006`). `http://<server-address>:<port+1>/AdminPanel` adresini açın.

Docker dağıtımı da desteklenmektedir:

```bash
docker pull lioensky/vcptoolbox:latest
docker-compose up -d
```

Dağıtık düğümler, yerel FC köprüleme (Codex / Zed / OpenCode), MCP köprüleri ve bağımsız bellek API'si için kimlik doğrulama ayrıntıları için [dağıtım ve operasyon kılavuzuna](docs/OPERATIONS.md) bakın.

### Önerilen ekosistem kurulumu

* **Resmi amiral gemisi ön ucu:** [VCPChat](https://github.com/lioensky/VCPChat) — tam V Engineering V2, VCPScriptorium, V Charts, VMusic ve VCPDesktop deneyimiyle paylaşılan IPC ekosisteminin ana barındırıcısı.
* **Önerilen yukarı akış API'leri:** [NewAPI](https://github.com/QuantumNous/new-api) veya [OpenRouter](https://openrouter.ai/) gibi SSE akışını ve standart biçimleri destekleyen resmi API'leri veya saygın toplayıcıları kullanın. **Asla resmi olmayan ters vekilleri veya aktarma API'lerini kullanmayın.**
* **Üçüncü taraf harness'lardan ve IDE'lerden doğrudan bağlantılar:** Araçlarını ve denetim çalışma zamanını paylaşmak için Codex, Zed, OpenCode, SnowCLI ve DeepSeekHarness gibi özel Base URL destekleyen istemcileri VCP uç noktasına yönlendirin.
* **VCPMobile** (topluluk projesi): [VCPMobile](https://github.com/MRiecy/VCPMobile) — yerel ağlarda dağıtık veri senkronizasyonunu ve mobil alt düğümleri destekleyen bir Tauri 2 mobil portu.
* **AIO-Hub** (topluluk projesi): [AIO-Hub](https://github.com/miaotouy/aio-hub) — kapsamlı yerleşik hata ayıklama araçlarına ve yerel VCP API uyumluluğuna sahip yüksek performanslı bir Tauri masaüstü LLM istemcisi.

---

## Lisans

Bu proje **CC BY-NC-SA 4.0** altında lisanslanmıştır. Ticari olmayan amaçlarla, atıfta bulunarak ve aynı lisans altında paylaşabilir ve uyarlayabilirsiniz. [`LICENSE`](LICENSE) dosyasına bakın.

---

## Teşekkürler

VCP gerçekten **kendi kendini başlatan (self-bootstrapping)** bir ekosistemdir. İnsan rehberliğinde sekizden fazla yapay zeka ajanı, VCP'nin kendi iş birliği ve mühendislik altyapısını kullanarak kodunun büyük bölümünü sürekli olarak tasarlamakta ve inşa etmektedir.

VCP'yi kullanan, geri bildirim gönderen, projeyi geliştiren veya eklenti ve dokümantasyon katkısında bulunan herkese ve Rust, Node.js, Python, SQLite, Electron ve Tantivy dahil olmak üzere üzerine inşa edildiği açık kaynaklı projelere teşekkür ederiz.

* **VCP ana sunucusu:** [VCPToolBox](https://github.com/lioensky/VCPToolBox)
* **Resmi amiral gemisi ön ucu:** [VCPChat](https://github.com/lioensky/VCPChat)
* **Dağıtık düğümler:** [VCPDistributedServer](https://github.com/lioensky/VCPDistributedServer)
* **Yedekleme sistemi:** [VCPBackUpDEV](https://github.com/lioensky/VCPBcakUpDEV)
* **İnsan rehberliği:** Ryan (莱恩) · lioensky

---

*VCP — Yapay zekaya bellek, mantık, eylem sürekliliği ve kendine ait bir ruh kazandırıyor.*

---

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lioensky/VCPToolBox)
