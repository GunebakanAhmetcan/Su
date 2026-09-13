# Su v5 — mevcut uygulamayı güncelle

Mevcut Netlify ve Supabase projelerini kullan. Yeni site, yeni eşleşme veya yeni anahtar oluşturman gerekmiyor.

## 1. Önce SQL güncellemesi

1. ZIP'i bilgisayarında klasöre çıkar.
2. `supabase/upgrade-v5.sql` dosyasını Not Defteri veya bir kod düzenleyiciyle aç.
3. Tamamını kopyala.
4. Supabase projen → **SQL Editor → New query**.
5. Yapıştır ve **Run** düğmesine bas.
6. `Success. No rows returned` benzeri başarılı sonucu gör. Hata varsa GitHub adımına geçmeden hata metnini paylaş.

Bu işlem mevcut kayıt ve eşleşmeleri korur. **Mevcut kurulumda setup.sql dosyasını yeniden çalıştırma.** Yalnızca upgrade-v5.sql gerekli. Sorgu tekrar çalıştırılabilir; değişiklikler tek işlem içinde uygulanır.

## 2. Dosyaları GitHub'a yükle

1. Uygulamanın mevcut GitHub reposunu aç.
2. **Add file → Upload files** seç.
3. ZIP'ten çıkardığın klasörün **içindeki dosya ve klasörlerin tamamını** yükle.
4. `package.json`, `package-lock.json`, `index.html` ve `netlify.toml` reponun ana dizininde kalmalı. Projeyi ikinci bir klasörün içine koyma.
5. **Commit changes** ile kaydet.

ZIP dosyasını tek başına GitHub'a yükleme. Özellikle `src`, `netlify/functions`, `supabase`, `scripts` klasörleri ve yeni `boot.js` dosyası eksik kalmasın. ZIP'e node_modules, dist veya kişisel anahtarlar dahil değildir.

## 3. Netlify yayınının bitmesini bekle

1. Netlify → mevcut proje → **Deploys** bölümünü aç.
2. Yeni GitHub commit'inden başlayan yayının **Published** olduğunu gör.
3. Otomatik başlamazsa **Trigger deploy** ile yeni yayın başlat.

Build komutu `npm run build`, yayın klasörü `dist`. netlify.toml bunları içerir. Mevcut ortam değişkenlerini, VAPID anahtarlarını ve Supabase webhook'unu koru.

İki fonksiyon bulunmalı: `send-push` ve `retry-push`. İkincisi üretim yayınında zamanlanmış çalışır. Webhook yine `/.netlify/functions/send-push` adresine gider; olay yalnızca INSERT, `x-webhook-secret` değeri mevcut WEBHOOK_SECRET ile aynı olmalı.

## 4. İki telefonu güncelle

1. İki kişi de **aynı mevcut uygulama adresini** internet varken açsın.
2. Ayarlar'da **Güncellemeyi aç** görünürse dokunsun.
3. Eski arayüz görünüyorsa uygulamayı ve aynı adresin açık Safari sekmelerini tamamen kapatıp yeniden açın. İlk açılış yeni sürümü indirebilir; bir kez daha kapatıp açmanız gerekebilir.
4. **Uygulamayı kaldırmayın, Safari/site verilerini silmeyin.** Mevcut kayıtlar ve eşleşme yerinde taşınır.
5. Özel miktarın altında “Özel miktarı düzenle”, kayıtlar altında “Geçmişi aç” görünmesi v5 arayüzünü doğrular.

## 5. Bildirimleri kontrol et

1. iPhone'da ana ekrandaki uygulama simgesinden açın.
2. Ayarlar'daki bildirim durumuna bakın.
3. **Bildirim bağlantısını yenile** görünüyorsa dokunun. Kapalıysa **Bu cihazda bildirimleri aç** seçin.
4. İki telefonda da “Bu cihazda bildirimler açık” göründükten sonra Birlikte panelinden tek bir hatırlatma gönderin.
5. Önce bekleme durumu, ardından gönderim servisine iletildi veya hata/tekrar deneme durumu görünür. Yeni hatırlatma için 30 saniye bekleme vardır.

Arkadaşın çevrimdışıysa bildirimi ekranda hemen görmeyebilir. Gönderim servisine kabul edilmesi ile telefonda görünmesi aynı şey değildir. Sunucuya ulaşamayan webhook istekleri ve geçici gönderim hataları zamanlanmış görevde tekrar denenir.

## 6. İkiniz de kurtarma kodunuzu saklayın

Her telefonda **Ayarlar → Kurtarma kodum → Kod oluştur → Kopyala**.

Herkes kendi kodunu güvenli bir yerde saklasın. Bu kod arkadaşına verilen davet kodundan farklıdır. Yeni cihazda Birlikte → **Eşleşmemi geri getir** bölümüne kendi kurtarma kodunu girersin. Aktarım eski cihazın eşleşme erişimini kapatır. Aktarımdan sonra yeni kurtarma kodu oluştur.

## 7. Kısa son kontrol

- 100 ml ekle, Geri al'a dokun; toplam eski değerine dönmeli.
- Özel miktarı düzenle; toplam değişmemeli. Kaydedilen miktara dokununca eklenmeli.
- Ayarlar'da çevrimdışı açılışın hazır olduğunu gör; interneti kapatıp uygulamayı yeniden aç. 250 ml ekle; bağlantı gelince kayıt karşıya eşitlenmeli.
- Birlikte bölümünde isimler ve günlük toplamlar doğru olmalı. Eski bir tarih seçerek geçmişi aç.
- Bildirim denemesinde gerçek iki telefon üzerindeki sonucu kontrol et.

İlk kez kullanılan bir cihaz siteye hücreselden hiç erişemiyorsa önce erişebildiği Wi-Fi ile açılması gerekir. Bu güncelleme, dosyaları kaydedilmiş uygulamanın ağ bekleyerek beyaz ekranda kalmasını giderir; operatörün siteye erişimini garanti etmez.
