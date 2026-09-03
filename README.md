# Su — PWA

Günlük su tüketimini hızlı biçimde kaydetmek için hazırlanmış, çevrimdışı çalışabilen statik PWA.

## GitHub ve Netlify kurulumu

1. ZIP dosyasını bilgisayarında klasöre çıkar.
2. GitHub'da yeni ve boş bir repository oluştur.
3. Bu klasörün içindeki tüm dosyaları repository'nin ana dizinine yükle.
4. Netlify'da **Add new project → Import an existing project → GitHub** yolunu izle.
5. Oluşturduğun repository'yi seç ve **Deploy** düğmesine bas.

Ek bir build komutu veya publish klasörü girmen gerekmez. netlify.toml ayarları hazırdır.

## Sonraki güncellemeler

1. Yeni sürüm ZIP'ini klasöre çıkar.
2. İçindeki dosyaları GitHub repository'nin ana dizinindeki eski dosyaların üzerine yükle.
3. Değişiklikleri commit et.
4. Netlify yeni commit'i otomatik olarak yayınlar.

ZIP dosyasının kendisini repository'ye yükleme; ZIP'in içindeki dosyaları yükle. Böylece GitHub kaynak dosyaları gösterir ve her güncelleme ayrı commit olarak izlenir.

## Özellikler

- Küçük, orta ve büyük bardakla tek dokunuşla ekleme
- 100, 250 ve 500 ml hızlı seçenekleri
- Son özel miktarı kaydetme ve tekrar kullanma
- Geri alma ve kayıt silme
- Günlük hedef ve bardak miktarlarını düzenleme
- Son yedi gün özeti
- Cihazda yerel veri saklama
- Otomatik koyu tema
- Deniz, zeytin, bej ve beyaz renk paletleri
- Sistem, açık ve koyu görünüm seçenekleri
- Ana ekrana kurulabilen çevrimdışı PWA

Veriler tarayıcının yerel depolamasında tutulur. Tarayıcı verileri silinirse kayıtlar da silinir.
