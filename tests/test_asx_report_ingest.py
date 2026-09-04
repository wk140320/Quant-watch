import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from quant_core.asx_report_ingest import ingest_asx_financial_report, parse_asx_financial_report


REPORT = """
ACME LIMITED
Appendix 4E and Annual Report
For the year ended 30 June 2025
Consolidated statement of profit or loss
Revenue from ordinary activities                 1,250  1,000
Profit/(loss) after tax                              80     (20)
Total assets                                    4,500  4,100
Total liabilities                               2,000  1,900
Cash and cash equivalents                         600    450
Net cash from operating activities                220    180
Basic earnings per share                         0.16   (0.04)
"""


class AsxReportIngestTests(unittest.TestCase):
    def test_accepts_labelled_facts_and_preserves_units(self):
        result = parse_asx_financial_report(
            "ACM",
            REPORT,
            source_url="https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
            report_period_end="2025-06-30",
            published_at="2025-08-01T08:00:00+10:00",
            report_title="Appendix 4E and Annual Report",
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["financialFactCount"], 7)
        self.assertEqual(result["values"]["revenue"], 1250)
        self.assertEqual(result["values"]["netIncome"], 80)
        self.assertEqual(result["values"]["dilutedEps"], 0.16)

    def test_scales_explicit_million_amounts_but_not_eps(self):
        report = REPORT.replace("Revenue from ordinary activities", "Amounts in A$ million\nRevenue from ordinary activities").replace(
            "Basic earnings per share", "Basic earnings per share"
        )
        result = parse_asx_financial_report(
            "ACM",
            report,
            source_url="https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
            report_period_end="2025-06-30",
            published_at="2025-08-01T08:00:00+10:00",
            report_title="Appendix 4E and Annual Report",
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["values"]["revenue"], 1_250_000_000)
        self.assertEqual(result["values"]["dilutedEps"], 0.16)

    def test_ignores_statement_note_references_and_eps_supporting_schedule(self):
        report = """
        Annual Report
        For the year ended 30 June 2019
        Other Revenue 2 3,538,774 2,020,175
        Cash and cash equivalents 5 5,555,875 2,306,048
        Basic and diluted loss per share (cents) 4 (5.00) (3.81)
        """
        result = parse_asx_financial_report(
            "1AD",
            report,
            source_url="https://announcements.asx.com.au/asxpdf/20190829/pdf/example.pdf",
            report_period_end=None,
            published_at="2019-08-29",
            report_title="Annual Report to shareholders",
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["values"]["revenue"], 3538774)
        self.assertEqual(result["values"]["cash"], 5555875)
        self.assertEqual(result["values"]["dilutedEps"], -5.0)

    def test_rejects_missing_publication_timestamp(self):
        result = parse_asx_financial_report(
            "ACM",
            REPORT,
            source_url="https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
            report_period_end="2025-06-30",
            published_at="",
            report_title="Appendix 4E and Annual Report",
        )
        self.assertFalse(result["accepted"])
        self.assertFalse(result["required"]["publishedAt"])

    def test_rejects_period_after_publication(self):
        result = parse_asx_financial_report(
            "ACM",
            REPORT,
            source_url="https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
            report_period_end="2025-09-30",
            published_at="2025-08-01T08:00:00+10:00",
            report_title="Appendix 4E and Annual Report",
        )
        self.assertFalse(result["accepted"])
        self.assertFalse(result["required"]["periodBeforePublished"])

    def test_rejects_index_document_symbol_mismatch(self):
        result = parse_asx_financial_report(
            "1TT",
            "Annual Report\nFor the year ended 30 June 2019\nASX code: RFN\nRevenue 100 90",
            source_url="https://announcements.asx.com.au/asxpdf/20190930/pdf/example.pdf",
            report_period_end=None,
            published_at="2019-09-30",
            report_title="Annual Report to shareholders",
        )
        self.assertFalse(result["accepted"])
        self.assertFalse(result["required"]["symbolMatchesDocument"])
        self.assertEqual(result["documentSymbol"], "RFN")

    def test_rejects_exchange_listing_code_mismatch(self):
        result = parse_asx_financial_report(
            "AAM",
            "Annual Report\nFor the year ended 30 June 2019\n"
            "The shares are listed on the Australian Securities Exchange (ASX) under the code MZZ.\n"
            "Revenue 100 90",
            source_url="https://announcements.asx.com.au/asxpdf/20190927/pdf/example.pdf",
            report_period_end=None,
            published_at="2019-09-27",
            report_title="Annual Report to shareholders",
        )
        self.assertFalse(result["accepted"])
        self.assertFalse(result["required"]["symbolMatchesDocument"])
        self.assertEqual(result["documentSymbol"], "MZZ")

    def test_extracts_as_of_period_from_financial_statements(self):
        result = parse_asx_financial_report(
            "6KA",
            "Financial Statements as of June 30, 2025 and December 31, 2024\nRevenue 100 90",
            source_url="https://announcements.asx.com.au/asxpdf/20251203/pdf/example.pdf",
            report_period_end=None,
            published_at="2025-12-03",
            report_title="Financial Statements as of June 30 2025 and December 31 2024",
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["event_time"], "2025-06-30T00:00:00+00:00")

    def test_prefers_statement_rows_over_narrative_and_non_capex_property_rows(self):
        report = """
        Annual Report
        For the year ended 31 December 2020
        Consolidated statement of profit or loss
        Net loss for the year after tax                 (6,837) (8,165)
        Basic and diluted loss per share                (0.115) (0.172)
        Consolidated statement of cash flows
        Payments for plant and equipment                   (27) (10)
        Gain on sale of property, plant and equipment        2  1
        The basic and diluted loss per share was $0.115 (2019: $0.172).
        """
        result = parse_asx_financial_report(
            "A1M",
            report,
            source_url="https://announcements.asx.com.au/asxpdf/20210330/pdf/example.pdf",
            report_period_end=None,
            published_at="2021-03-30",
            report_title="Annual Report 31 December 2020",
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(result["values"]["netIncome"], -6837)
        self.assertEqual(result["values"]["dilutedEps"], -0.115)
        self.assertEqual(result["values"]["capitalExpenditure"], -27)
        self.assertNotIn("ebitda", result["values"])

    def test_ingest_writes_disclosure_and_numeric_layers(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "report.txt"
            source.write_text(REPORT, encoding="utf-8")
            result = ingest_asx_financial_report({
                "root": str(root / "lake"),
                "symbol": "ACM",
                "document_path": str(source),
                "source_url": "https://www.asx.com.au/asxpdf/20250801/pdf/example.pdf",
                "report_period_end": "2025-06-30",
                "published_at": "2025-08-01T08:00:00+10:00",
                "report_title": "Appendix 4E and Annual Report",
            })
            self.assertTrue(result["accepted"])
            self.assertEqual(set(result["savedDatasets"]), {"financial_disclosures", "fundamentals"})
            self.assertTrue((root / "lake" / "fundamentals" / "market=ASX" / "exchange=ASX" / "symbol=ACM" / "data.parquet").exists())


if __name__ == "__main__":
    unittest.main()
