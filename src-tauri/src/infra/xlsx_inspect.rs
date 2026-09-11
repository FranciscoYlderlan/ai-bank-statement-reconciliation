//! Inspecao de layout do .xlsx (leitura leve via zip) para o Contrato de
//! Layout (§12.0) no onboarding. NAO escreve — apenas confere estrutura.
use std::io::Read;
use zip::ZipArchive;

fn read_zip_entry(bytes: &[u8], name: &str) -> Option<String> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = ZipArchive::new(reader).ok()?;
    let mut file = zip.by_name(name).ok()?;
    let mut s = String::new();
    file.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Nomes das abas na ordem do workbook.
pub fn sheet_names(bytes: &[u8]) -> Result<Vec<String>, String> {
    let wb = read_zip_entry(bytes, "xl/workbook.xml")
        .ok_or_else(|| "workbook.xml ausente".to_string())?;
    let re = regex::Regex::new(r#"<sheet [^>]*name="([^"]+)""#).map_err(|e| e.to_string())?;
    Ok(re
        .captures_iter(&wb)
        .map(|c| xml_unescape(&c[1]))
        .collect())
}

/// Le a linha de cabecalho (`header_row`) de uma aba, resolvendo shared strings.
pub fn header_row(bytes: &[u8], sheet_name: &str, header_row: u32) -> Result<Vec<String>, String> {
    // mapeia nome -> arquivo via workbook + rels
    let wb = read_zip_entry(bytes, "xl/workbook.xml").ok_or("workbook.xml ausente")?;
    let rels = read_zip_entry(bytes, "xl/_rels/workbook.xml.rels").ok_or("rels ausente")?;
    let re_sheet =
        regex::Regex::new(r#"<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)""#).map_err(|e| e.to_string())?;
    let re_rel =
        regex::Regex::new(r#"Id="(rId\d+)"[^>]*Target="(worksheets/sheet\d+\.xml)""#).map_err(|e| e.to_string())?;
    let mut rid = None;
    for c in re_sheet.captures_iter(&wb) {
        if xml_unescape(&c[1]) == sheet_name {
            rid = Some(c[2].to_string());
        }
    }
    let rid = rid.ok_or("aba nao encontrada")?;
    let mut target = None;
    for c in re_rel.captures_iter(&rels) {
        if c[1] == rid {
            target = Some(format!("xl/{}", &c[2]));
        }
    }
    let target = target.ok_or("rel da aba nao encontrado")?;
    let sheet_xml = read_zip_entry(bytes, &target).ok_or("sheet xml ausente")?;
    let shared = read_zip_entry(bytes, "xl/sharedStrings.xml").unwrap_or_default();
    let shared_vec = parse_shared_strings(&shared);

    // extrai a linha do cabecalho
    let re_row = regex::Regex::new(&format!(r#"<row r="{header_row}"[^>]*>(.*?)</row>"#))
        .map_err(|e| e.to_string())?;
    let row = re_row
        .captures(&sheet_xml)
        .map(|c| c[1].to_string())
        .unwrap_or_default();

    let re_cell = regex::Regex::new(r#"<c [^>]*?(t="[^"]*")?[^>]*>(.*?)</c>"#).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for c in re_cell.captures_iter(&row) {
        let is_shared = c.get(1).map(|m| m.as_str().contains("t=\"s\"")).unwrap_or(false);
        let inner = &c[2];
        let val = if is_shared {
            inner
                .trim_start_matches("<v>")
                .trim_end_matches("</v>")
                .parse::<usize>()
                .ok()
                .and_then(|i| shared_vec.get(i).cloned())
                .unwrap_or_default()
        } else if inner.contains("<is>") {
            extract_between(inner, "<t", "</t>")
        } else {
            inner.trim_start_matches("<v>").trim_end_matches("</v>").to_string()
        };
        if !val.trim().is_empty() {
            out.push(xml_unescape(val.trim_start_matches('>')));
        }
    }
    Ok(out)
}

fn parse_shared_strings(xml: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"<si>(.*?)</si>"#).unwrap();
    re.captures_iter(xml)
        .map(|c| xml_unescape(&extract_between(&c[1], "<t", "</t>")))
        .collect()
}

fn extract_between(s: &str, start: &str, end: &str) -> String {
    if let Some(i) = s.find(start) {
        if let Some(gt) = s[i..].find('>') {
            let after = &s[i + gt + 1..];
            if let Some(j) = after.find(end) {
                return after[..j].to_string();
            }
        }
    }
    String::new()
}

fn xml_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}
