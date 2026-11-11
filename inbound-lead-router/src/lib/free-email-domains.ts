// Consumer, free and disposable email providers. A signup from one of these
// domains says nothing about the person's employer, so the pipeline never
// spends credits enriching it. Add domains here as you see them in your data.
// Subdomains match too: `mail.yahoo.com` is covered by `yahoo.com`.

export const FREE_EMAIL_DOMAINS: readonly string[] = [
  // Global providers
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'aol.com', 'aim.com', 'verizon.net',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tuta.io', 'tutamail.com',
  'zohomail.com', 'zohomail.eu',
  'fastmail.com', 'fastmail.fm', 'hey.com',
  'mail.com', 'email.com', 'usa.com', 'myself.com', 'consultant.com', 'post.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.fr', 'gmx.co.uk',
  'yandex.com', 'yandex.ru', 'ya.ru',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'rambler.ru',
  'hushmail.com', 'runbox.com', 'posteo.de', 'posteo.net', 'mailbox.org', 'disroot.org', 'riseup.net',
  'duck.com', 'skiff.com', 'startmail.com', 'mailfence.com', 'kolabnow.com',
  // Regional Hotmail, Outlook, Live and Yahoo domains
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it', 'hotmail.es', 'hotmail.nl', 'hotmail.be',
  'hotmail.ca', 'hotmail.com.au', 'hotmail.com.br', 'hotmail.co.jp', 'hotmail.se', 'hotmail.dk', 'hotmail.no',
  'outlook.fr', 'outlook.de', 'outlook.it', 'outlook.es', 'outlook.co.uk', 'outlook.com.au', 'outlook.com.br',
  'outlook.jp', 'outlook.in', 'outlook.sa', 'outlook.com.tr',
  'live.co.uk', 'live.fr', 'live.de', 'live.it', 'live.nl', 'live.ca', 'live.com.au', 'live.com.mx', 'live.se',
  'live.dk', 'live.no', 'live.be', 'live.cn',
  'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es', 'yahoo.ca', 'yahoo.com.au', 'yahoo.com.br',
  'yahoo.com.mx', 'yahoo.com.ar', 'yahoo.co.in', 'yahoo.in', 'yahoo.co.jp', 'yahoo.com.sg', 'yahoo.com.ph',
  'yahoo.com.tw', 'yahoo.com.hk', 'yahoo.co.id', 'yahoo.gr', 'yahoo.se', 'yahoo.dk', 'yahoo.no', 'yahoo.ie',
  'yahoo.co.nz', 'yahoo.com.vn', 'yahoo.com.tr',
  // Europe
  'web.de', 'freenet.de', 't-online.de', 'arcor.de', 'online.de',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'neuf.fr', 'club-internet.fr',
  'libero.it', 'virgilio.it', 'alice.it', 'tin.it', 'tiscali.it', 'email.it',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'blueyonder.co.uk', 'ntlworld.com',
  'ziggo.nl', 'kpnmail.nl', 'home.nl', 'planet.nl', 'telenet.be', 'skynet.be',
  'seznam.cz', 'centrum.cz', 'atlas.cz', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl',
  'bluewin.ch', 'sunrise.ch', 'a1.net', 'chello.at', 'telia.com', 'online.no', 'eircom.net',
  'abv.bg', 'freemail.hu', 'citromail.hu', 'sapo.pt', 'terra.es', 'ukr.net', 'i.ua', 'meta.ua',
  // Americas
  'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'charter.net', 'cox.net', 'earthlink.net',
  'optonline.net', 'frontier.com', 'windstream.net', 'juno.com', 'netzero.net', 'mindspring.com',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'videotron.ca', 'telus.net',
  'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com', 'prodigy.net.mx',
  // Asia Pacific, Middle East and Africa
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com',
  '139.com', '189.cn', 'naver.com', 'hanmail.net', 'daum.net', 'kakao.com', 'nate.com',
  'rediffmail.com', 'yahoo.co.kr', 'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'nifty.com', 'ocn.ne.jp',
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au', 'xtra.co.nz',
  'walla.co.il', 'mweb.co.za', 'telkomsa.net',
  // Disposable inboxes
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la',
  '10minutemail.com', 'temp-mail.org', 'tempmail.com', 'tempmailo.com', 'throwawaymail.com',
  'yopmail.com', 'yopmail.fr', 'getnada.com', 'nada.email', 'trashmail.com', 'dispostable.com',
  'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'mohmal.com', 'fakeinbox.com', 'emailondeck.com',
  'spamgourmet.com', 'mailcatch.com', 'burnermail.io', 'inboxkitten.com', 'tempail.com', 'moakt.com',
  'mytemp.email', 'tempr.email', 'discard.email', 'spambox.us', 'mailpoof.com', 'fexpost.com',
];
