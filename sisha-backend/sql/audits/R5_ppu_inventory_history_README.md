# R5 — Histórico quantitativo do Inventário PPU (draft)

## Escopo
Uma estrutura histórica distinta do saldo vigente, pois as tabelas de snapshot de equipamentos exigem SN e não representam sobressalentes. A tabela operacional estoque_ppu, Livro de Equipamentos, Recibos, LOCREC, Radar e Chat Lince não são alterados nesta etapa. Não versionar payload de produção no GitHub. A migration não captura nada automaticamente.

## Contrato
- Baseline legado: preserva todas as linhas, inclusive SN, quantidades zero e datas existentes, sem inferir data operacional. A data observacional fica NULL até evidência externa; R6 deve exigir validação documental de datas antes de aplicar baixas automáticas.
- Captura requer os dois hashes obtidos no precheck em UTC. Repetição com estado idêntico retorna o mesmo snapshot; alteração de estoque ou regras bloqueia.
- Uma cadeia única por predecessor, hash SHA-256 do arquivo original único, import_log_id único, payload integral e hash de conteúdo verificado. Sem UPDATE/DELETE/TRUNCATE de histórico.
- A comparação PN + localização é consultiva: não comprova origem, não movimenta SN, não baixa recibo. Local não classificado retorna NULL.
- R6: reutilizar a trava advisory sisha_ppu_inventory_reconciliation; bloquear estoque e políticas em ordem consistente, obter e verificar estado vigente, bloquear recibos candidatos, validar data/completude e idempotência antes de substituir estoque. Na mesma transação, gravar versão nova, eventos e incorporações. Um erro deve reverter todas as alterações. Não utilizar importador destrutivo atual para a primeira reconciliação.
- A classificação de políticas é preservada conforme existente no momento da captura; mudanças futuras de política não alteram evidência histórica. Reimportação do mesmo arquivo não constitui nova incorporação. A ausência de SN no ODS não autoriza alterar o Livro.
- A origem contábil por quantidade/FIFO permanece inferência. O LOCREC requer validação temporal e compatibilidade de destino; caso conflitante fica pendente.

## Gates
1. Precheck SQL somente leitura em UTC; conferir contagem e hashes e verificar que a tabela ainda não existe.
2. Validar migration em PostgreSQL isolado/staging e executar regressões Node. A criação do arquivo de migration não equivale a sua execução.
3. Aplicar migration apenas em janela autorizada; verificar grants/RLS, trigger imutável, tabela vazia, regressões e assinaturas de estoque/recibos intactas.
4. Capturar baseline explicitamente com ambos os hashes esperados; repetir e verificar mesmo UUID/contagens. Captura não importa ODS nem baixa Recibos.
5. Comparar snapshots com teste de remanejamento A-1 -> Z, quantidades fracionárias, local desconhecido, SN preservado no payload, hash inválido, snapshot inexistente, reimportação, falha transacional e concorrência antes da promoção R6.

## Limites
O hash do precheck não é backup. A preservação durável só existe após execução e verificação da captura. A migration ainda não integra o importador e não deve ser aplicada isoladamente sem validação em ambiente apropriado. Nenhum valor de produção ou credencial neste commit.
