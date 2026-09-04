# İki kişilik Su uygulaması — kurulum

Bu kurulumda hosting Netlify'da, ortak veriler Supabase'de tutulur. Alan adı veya ücretli Hostinger paketi gerekmez.

## 1. Supabase projesini oluştur

1. [supabase.com](https://supabase.com/) adresinde ücretsiz hesap aç.
2. **New project** seç.
3. Bir proje adı ve güçlü bir database password belirle.
4. Bölge olarak sana yakın bir bölge seç ve projenin hazırlanmasını bekle.

## 2. Şifresiz cihaz oturumunu aç

1. Supabase sol menüsünden **Authentication** bölümünü aç.
2. **Sign In / Providers** veya **Providers** sayfasına gir.
3. **Anonymous Sign-Ins** seçeneğini aç ve kaydet.

Uygulamada kullanıcı adı/parola ekranı görünmez. Her telefon Supabase'de anonim ve ayrı bir cihaz kimliği alır.

## 3. Veritabanını kur

1. Bu ZIP'teki **supabase/setup.sql** dosyasını bir metin düzenleyiciyle aç.
2. Dosyanın tamamını kopyala.
3. Supabase'de **SQL Editor → New query** aç.
4. Kodu yapıştır ve **Run** düğmesine bas.
5. Sonuçta hata görünmemeli.

## 4. Supabase anahtarlarını al

Supabase'de **Project Settings → API Keys** (bazı görünümlerde **Data API**) bölümünü aç.

Şunları ayrı bir yere kopyala:

- **Project URL**
- **Publishable key** (sb_publishable_...; eski projelerde anon key)
- **Secret key** (sb_secret_...; eski projelerde service_role)

Secret key'i hiçbir zaman GitHub'a yükleme.

## 5. Bildirim anahtarlarını üret

1. ZIP'teki **tools/anahtar-olustur.html** dosyasına çift tıkla.
2. Tarayıcıda **Anahtarları oluştur** düğmesine bas.
3. Üretilen üç değeri ayrı bir yere kopyala:
   - PUBLIC_VAPID_KEY
   - VAPID_PRIVATE_KEY
   - WEBHOOK_SECRET
4. Bu sayfayı veya değerleri herkese gönderme.

## 6. Kodları GitHub'a yükle

Mevcut repository'yi kullanıyorsan:

1. GitHub'da repository'yi aç.
2. **Add file → Upload files** seç.
3. ZIP'i değil, ZIP'ten çıkardığın klasörün içindeki bütün dosya ve klasörleri yükle.
4. **Commit changes** ile kaydet.

Yeni repository kullanıyorsan aynı şekilde boş repository'nin ana dizinine yükle. **src**, **scripts**, **netlify**, **supabase** ve **tools** klasörleri de GitHub'da görünmeli.

## 7. Netlify değişkenlerini ekle

Netlify'da uygulama projesini aç ve **Project configuration → Environment variables** bölümüne gir. Aşağıdaki altı değişkeni ekle:

| Değişken | Değer |
| --- | --- |
| PUBLIC_SUPABASE_URL | Supabase Project URL |
| PUBLIC_SUPABASE_ANON_KEY | Supabase Publishable/anon key |
| SUPABASE_SECRET_KEY | Supabase Secret/service_role key |
| PUBLIC_VAPID_KEY | Anahtar sayfasındaki public key |
| VAPID_PRIVATE_KEY | Anahtar sayfasındaki private key |
| WEBHOOK_SECRET | Anahtar sayfasındaki webhook secret |

Değişkenleri kaydettikten sonra **Deploys → Trigger deploy → Deploy site** ile yeni yayın başlat. Build ayarlarını elle değiştirme; **netlify.toml** bunları otomatik yapar.

## 8. Bildirim webhook'unu oluştur

Netlify yayını tamamlandıktan sonra Supabase'e dön:

1. **Database → Webhooks** bölümünü aç.
2. **Create a new webhook** seç.
3. Ad: **su-bildirimi**
4. Schema: **public**
5. Table: **notification_jobs**
6. Event: yalnızca **INSERT**
7. Method: **POST**
8. URL: **https://SENIN-NETLIFY-ADRESIN.netlify.app/.netlify/functions/send-push**
9. Header ekle:
   - Ad: **x-webhook-secret**
   - Değer: Netlify'a yazdığın **WEBHOOK_SECRET**
10. Kaydet.

Özel alan adı kullanıyorsan webhook URL'sinde Netlify adresi yerine özel alan adını da kullanabilirsin.

## 9. İki telefonu eşleştir

Birinci telefonda:

1. Uygulamayı Safari/Chrome'da aç.
2. iPhone ise **Paylaş → Ana Ekrana Ekle** ile kur ve ana ekrandaki simgeden aç.
3. Sağ üstteki iki kişi simgesine dokun.
4. İsmini yazıp **Yeni eşleşme oluştur** de.
5. Davet kodunu ikinci kişiye gönder.
6. **Bu cihazda bildirimleri aç** düğmesine bas ve izni ver.

İkinci telefonda:

1. Aynı uygulama adresini aç ve ana ekrana kur.
2. İki kişi simgesini aç.
3. İsmini ve davet kodunu yazıp **Koda katıl** de.
4. Bildirimleri aç ve izni ver.

Ana ekranda herkes yalnızca kendi su kaydını görür. İki kişinin yedi günlük tablosu ve hatırlatma düğmesi yalnızca **Birlikte** panelindedir.

## Dikkat

- Kullanıcı adı/parola olmadığı için cihaz kimliği tarayıcı verisinde tutulur. Safari/site verisini silme ve uygulamayı eşleşme tamamlandıktan sonra kaldırıp yeniden kurma.
- Kişisel su ekleme çevrimdışıyken devam eder; ortak tablo, senkronizasyon ve bildirim için internet gerekir.
- iPhone'da web bildirimi için uygulamanın ana ekrana eklenmiş olması gerekir.
- GitHub'a .env dosyası, Secret key, VAPID private key veya webhook secret yükleme.
