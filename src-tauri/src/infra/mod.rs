//! FRAMEWORKS & DRIVERS — detalhes concretos (I/O, zip, COM, IA, Google).
pub mod ai;
pub mod backup;
pub mod google;
pub mod rules_store;
pub mod secrets;
pub mod xlsx_inspect;

#[cfg(windows)]
pub mod com_excel;
