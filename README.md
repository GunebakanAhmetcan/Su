# Su — iki kişilik PWA

Ana ekranı kişisel kalan, iki kişinin geçmişini ayrı bir panelde gösteren su takip uygulaması.

## Özellikler

- Küçük, orta ve büyük bardakla tek dokunuşla ekleme
- 100, 250, 500 ml ve kaydedilen özel miktar
- Geri alma, kayıt silme ve son yedi gün grafiği
- Deniz, zeytin, bej ve beyaz temalar
- Açık, koyu ve sistem görünümü
- Çevrimdışı kişisel kayıt
- Davet koduyla en fazla iki cihazı eşleştirme
- Ayrı Birlikte panelinde iki kişinin yedi günlük tablosu
- Diğer kişiye web push hatırlatması
- Supabase Row Level Security ile eşleşme dışındaki verileri kapatma

Kurulum için **KURULUM.md** dosyasını sırayla uygula.

## GitHub → Netlify

Netlify ayarları **netlify.toml** içindedir:

- Build command: **npm run build**
- Publish directory: **dist**
- Functions directory: **netlify/functions**

Yeni güncellemelerde kaynak dosyaları GitHub repository'ye yükleyip commit etmek yeterlidir; Netlify otomatik yayınlar.
