/** Classe de fluxo de caixa da coluna B da aba Categorias. */
export type FlowClass =
  | "RECEITA"
  | "DESPESAS FIXAS"
  | "GASTOS VARIÁVEIS"
  | "INVESTIMENTOS"
  | "NÃO OPERACIONAL";

export interface CategoryDef {
  name: string; // coluna A da aba Categorias
  flow: FlowClass; // coluna B
}

/**
 * Categorias reais extraidas da planilha Cantina Bom Prato (aba `Categorias`, A2:B38).
 * Usadas pelo gerador de planilha do zero e pelo dashboard.
 */
export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { name: "Recebimento de venda", flow: "RECEITA" },
  { name: "Aluguel", flow: "DESPESAS FIXAS" },
  { name: "Vale transporte", flow: "DESPESAS FIXAS" },
  { name: "Fornecedor", flow: "GASTOS VARIÁVEIS" },
  { name: "Salário", flow: "DESPESAS FIXAS" },
  { name: "Material escritório/limpeza", flow: "DESPESAS FIXAS" },
  { name: "Gás", flow: "GASTOS VARIÁVEIS" },
  { name: "Combustível", flow: "DESPESAS FIXAS" },
  { name: "Manutenção", flow: "INVESTIMENTOS" },
  { name: "Impressão", flow: "DESPESAS FIXAS" },
  { name: "Não Operacional", flow: "NÃO OPERACIONAL" },
  { name: "Motoboys", flow: "GASTOS VARIÁVEIS" },
  { name: "Investimento", flow: "INVESTIMENTOS" },
  { name: "Prolabore", flow: "DESPESAS FIXAS" },
  { name: "Retirada socios", flow: "NÃO OPERACIONAL" },
  { name: "Ajuda de custo - motoboy", flow: "GASTOS VARIÁVEIS" },
  { name: "Vale Alimentação", flow: "DESPESAS FIXAS" },
  { name: "Diárias - free lancer", flow: "DESPESAS FIXAS" },
  { name: "Farmácia", flow: "DESPESAS FIXAS" },
  { name: "DAS Simples Nacional", flow: "GASTOS VARIÁVEIS" },
  { name: "Embalagens", flow: "GASTOS VARIÁVEIS" },
  { name: "Móveis e Utensílios", flow: "INVESTIMENTOS" },
  { name: "Taxa de cartão", flow: "GASTOS VARIÁVEIS" },
  { name: "Taxa Ifood", flow: "GASTOS VARIÁVEIS" },
  { name: "DAS - MEI", flow: "DESPESAS FIXAS" },
  { name: "Energia Elétrica", flow: "DESPESAS FIXAS" },
  { name: "Internet e Telefone", flow: "DESPESAS FIXAS" },
  { name: "Contador", flow: "DESPESAS FIXAS" },
  { name: "Softwares", flow: "DESPESAS FIXAS" },
  { name: "Empréstimos", flow: "NÃO OPERACIONAL" },
  { name: "Aporte de capital", flow: "NÃO OPERACIONAL" },
  { name: "Água e esgoto", flow: "DESPESAS FIXAS" },
  { name: "Marketing", flow: "INVESTIMENTOS" },
  { name: "Troco e devolução", flow: "NÃO OPERACIONAL" },
  { name: "Comissões", flow: "GASTOS VARIÁVEIS" },
  { name: "FGTS", flow: "DESPESAS FIXAS" },
  { name: "INSS", flow: "DESPESAS FIXAS" },
];
