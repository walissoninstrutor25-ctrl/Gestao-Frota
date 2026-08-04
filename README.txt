LOTS — GESTÃO DE FROTA
========================

O QUE TEM NESTA PASTA
----------------------
index.html              -> o sistema completo (abrir este arquivo no navegador)
manifest.webmanifest    -> permite "instalar" o app na tela inicial (celular/PC)
sw.js                   -> deixa o app abrir mesmo sem internet (guarda a "casca" do app)
assets/                 -> logo LOTS Group (usada no login e menu)

ANTES DE USAR
-------------
1. Abra o index.html num editor de texto.
2. Procure por "firebaseConfig" perto do início do <script>.
3. Cole ali os dados do SEU projeto Firebase (veja console.firebase.google.com).
4. No Firebase, ative Authentication > Sign-in method > E-mail/senha.
5. No Firestore > Regras, cole as regras de segurança que o Claude te passou no chat.

ONDE OS DADOS FICAM SALVOS
---------------------------
Os dados (veículos, abastecimentos, custos, multas, usuários) NÃO ficam
dentro desta pasta — ficam guardados na nuvem, no seu projeto Firebase.
Por isso, esta pasta pode ser copiada, movida ou hospedada em qualquer
lugar (GitHub Pages, servidor da empresa, outro computador) sem perder
nada, DESDE QUE o firebaseConfig dentro do index.html continue sendo o
mesmo projeto Firebase.

TRANSFERINDO PARA OUTRO COMPUTADOR
------------------------------------
Basta copiar esta pasta inteira (ou o .zip) para o outro computador e
abrir o index.html. Como os dados estão no Firebase, tudo aparece
exatamente igual, sem precisar reconfigurar nada além do navegador ter
internet na primeira abertura (depois disso, o app abre offline também,
graças ao sw.js e à persistência offline do Firestore).

HOSPEDANDO (GitHub Pages, servidor, etc.)
-------------------------------------------
Suba TODOS os arquivos desta pasta (não só o index.html) mantendo a
mesma estrutura de pastas — o manifest.webmanifest, o sw.js e a pasta
assets/ precisam estar no mesmo nível do index.html.
