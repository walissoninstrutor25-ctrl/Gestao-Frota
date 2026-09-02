# Atualizar os dados das escalas

Os dados que o app mostra (`../data/*.js`) são gerados a partir das 3
planilhas oficiais — eles **não** são lidos da planilha em tempo real.
Para atualizar (nova safra, troca de colaborador, correção de mês etc.),
gere as planilhas atualizadas no mesmo formato das originais e rode:

```bash
pip install openpyxl   # se ainda não tiver
python3 gerar_dados.py \
  --motoristas "Escala_5x1_Motorista_Canavieiro_Safra_2027.xlsx" \
  --lideres    "Escala_6X2_Lideres_de_Turno_e_Patio_MNS.xlsx" \
  --master     "Escala_5X1_Master_Drivers_MNS_PRA.xlsx" \
  --outdir ../data
```

Isso sobrescreve os arquivos em `../data/`. Recarregue a página do app
para ver os dados novos (não precisa build nem deploy separado).

Os arquivos são `.js`, não `.json`: cada um só define uma variável
(`window.DATA_MOTORISTAS_META = {...}`, por exemplo) e é carregado pelo
`index.html` via `<script src="...">`. Isso é proposital — assim o app
funciona igual tanto aberto direto do disco (duplo-clique) quanto
hospedado; com `fetch()`/`.json`, o navegador bloqueia o carregamento
quando a página é aberta sem servidor. Se adicionar um novo arquivo de
dados, lembre de incluir o `<script src="...">` correspondente no
`index.html`, antes de `js/app.js`.

## Formato esperado da planilha

- Abas `NOMES`, `MESTRE` e uma aba por mês (`MARÇO` .. `DEZEMBRO`).
- Em cada aba de mês, uma linha por colaborador com os dias `1..31` (ou
  `1..30`/`1..28`, conforme o mês) nas colunas.
- O status trabalha/folga é lido pela **cor de preenchimento** da célula do
  dia (branco/sem preenchimento = trabalha, cinza = folga) — o número do
  dia digitado na célula é só rótulo, o texto em si não importa.
- Ano da safra: troque a constante `YEAR` no topo de `gerar_dados.py`.

## Observações sobre a planilha atual (Safra 2026)

O script já contorna alguns problemas encontrados nas planilhas originais
(e vai continuar contornando, se a próxima planilha tiver os mesmos
problemas):

- Linhas/matrículas quebradas (`#REF!`, `#N/A`) são ignoradas.
- Vagas em aberto (linha sem nome) não entram na lista de colaboradores.
- A identidade de cada colaborador é resolvida pelo **nome**, não pela
  matrícula — a matrícula, nas planilhas de origem, ocasionalmente muda de
  um mês para o outro por erro de fórmula, enquanto o nome se mantém
  estável.
- A aba `DEZEMBRO` da planilha de Master Driver (Safra 2026) veio com o
  conteúdo da planilha de Líder de Turno/Pátio por engano; o script
  detecta isso pelo título da aba e ignora aquele mês em vez de mostrar
  dado errado. Se a planilha for corrigida, o mês volta a aparecer
  automaticamente.
