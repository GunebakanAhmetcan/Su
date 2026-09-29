# Su v5.1 — iki kişilik PWA

Ana ekranı kişisel kalan, iki kişinin geçmişini ayrı bir panelde gösteren su takip uygulaması.

## Özellikler

- Küçük, orta ve büyük bardakla tek dokunuşla ekleme
- 100, 250, 500 ml ve kaydedilen özel miktar
- Kalıcı ekleme/silme kuyruğu, güvenilir geri alma ve son yedi gün grafiği
- Deniz, zeytin, bej ve beyaz temalar
- Açık, koyu ve sistem görünümü
- Kayıtlı dosyalardan ağ beklemeden açılış ve çevrimdışı kişisel kayıt
- Davet koduyla en fazla iki cihazı eşleştirme
- Ayrı Birlikte panelinde tarihle seçilebilen ortak geçmiş, yerel önbellek
- Cihazın bildirim aboneliğini açma, kapatma, onarma; gönderim durumu ve otomatik tekrar deneme
- Tek kullanımlık kişisel kurtarma koduyla cihaz aktarımı
- Çift dokunmayla yakınlaşmayı önleyen davranış; iki parmakla yakınlaşma açık
- Daha büyük düğmeler, okunaklı yazılar ve kısa açılış/kapanış geçişleri
- Özel miktarı düzenleme ve su ekleme ayrı işlemler
- Geçmişte gün seçip toplu miktar ekleme; mevcut kaydın miktarını düzenleme ve geri alma
- Supabase Row Level Security ile eşleşme dışındaki verileri kapatma

Mevcut uygulamayı güncellemek için **GUNCELLEME.md**, sıfırdan kurulum için **KURULUM.md** dosyasını izle.

V5.1'de geçmiş kaydı: **Kayıtlar → Geçmişi aç → gün seç → Bu güne su ekle**. Bir kaydı değiştirmek için yanındaki kaleme dokun. Girilen miktar o günün toplamına eklenir; kalemle düzenleme ise mevcut kaydı değiştirir. Sonradan girilen kayıtlar “Sonradan” olarak görünür. Bu ekran tek kayıtta 1–10.000 ml kabul eder. Ana ekranın özel miktar ayarı değişmez.

V5 SQL güncellemesi zaten uygulandıysa bu sürüm için yeni SQL veya ortam değişkeni gerekmez.

## GitHub → Netlify

Netlify ayarları **netlify.toml** içindedir:

- Build command: **npm run build**
- Publish directory: **dist**
- Functions directory: **netlify/functions**

Yeni güncellemelerde kaynak dosyaları GitHub repository'ye yükleyip commit etmek yeterlidir; Netlify otomatik yayınlar.

## Geliştirme ve test

Node 22 veya üzeri:

```sh
npm ci
npm test
npm run check
npm run build
```

Testler gerçek servislere istek göndermez. Veri kuyruğu, PostgreSQL/RLS ve kurtarma, bildirim göndericisi, service worker ve DOM etkileşimleri yerel ortamda sınanır. DOM testleri gerçek iPhone/Safari görsel testi değildir. Cihazdaki son kontrol adımları GUNCELLEME.md içindedir.

Tarayıcı paketine yalnızca build dosyasında açıkça seçilmiş üç PUBLIC_ değeri girer. Özel anahtarları kaynak dosyalara yazma.

## Sınırlar

İlk kez açılan cihazın siteye erişebilen bir internet bağlantısı gerekir. Operatör/DNS kaynaklı erişim sorunu uygulama koduyla garanti olarak çözülmez. Dosyaları kaydedilmiş cihazda kişisel takip çevrimdışı çalışır. Ortak veri eşitlemesi ve bildirim gönderimi internet ister.

“Gönderim servisine iletildi” telefonun bildirimi ekranda gösterdiğinin kanıtı değildir. Telefonun bağlantısı, izinleri ve Odak ayarları etkiler. Tekrar denemeler üretim Netlify yayınında 10 dakikalık zamanlanmış görevle yapılır; uygulamanın açık kalması gerekmez. Bir bildirim en fazla dört gönderim denemesi yapar ve bir saat sonra zaman aşımına düşer.

Kurtarma kodu yalnızca sunucuya eşitlenmiş verileri geri getirir. Yeni kod önceki kodu iptal eder; aktarım kodu tek kullanımlıktır. Kodun kendisi veritabanına kaydedilmez, SHA-256 özeti özel şemada saklanır.
