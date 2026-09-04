import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from fetch_asx_financial_reports import _download  # noqa: E402


class FakeResponse:
    def __init__(self, body: bytes, content_type: str = "text/html", url: str = "https://www.asx.com.au/test"):
        self._body = body
        self.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        self.status = 200
        self._url = url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self._body

    def geturl(self):
        return self._url


class AsxFetchPolicyTests(unittest.TestCase):
    def test_access_terms_page_is_not_treated_as_pdf(self):
        body = b"<html>Access to this site announcementTerms.do Agree and proceed</html>"
        with TemporaryDirectory() as temporary, patch(
            "fetch_asx_financial_reports.urlopen", return_value=FakeResponse(body)
        ):
            document, error, transport = _download(
                "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=1",
                Path(temporary) / "report.pdf",
            )
        self.assertIsNone(document)
        self.assertEqual(error, "access-terms-interstitial")
        self.assertTrue(transport["accessTermsPage"])
        self.assertFalse(transport["pdfMagic"])

    def test_pdf_content_type_does_not_override_pdf_magic_check(self):
        body = b"<html>not a document</html>"
        with TemporaryDirectory() as temporary, patch(
            "fetch_asx_financial_reports.urlopen",
            return_value=FakeResponse(body, content_type="application/pdf"),
        ):
            document, error, transport = _download(
                "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=2",
                Path(temporary) / "report.pdf",
            )
        self.assertIsNone(document)
        self.assertEqual(error, "response-is-not-pdf")
        self.assertFalse(transport["pdfMagic"])

    def test_real_pdf_magic_is_saved(self):
        body = b"%PDF-1.4\nminimal test payload"
        with TemporaryDirectory() as temporary, patch(
            "fetch_asx_financial_reports.urlopen",
            return_value=FakeResponse(body, content_type="application/pdf"),
        ):
            document, error, transport = _download(
                "https://www.asx.com.au/asxpdf/20250901/pdf/example.pdf",
                Path(temporary) / "report.pdf",
            )
            self.assertIsNotNone(document)
            self.assertIsNone(error)
            self.assertTrue(transport["pdfMagic"])
            self.assertEqual(Path(document).read_bytes(), body)


if __name__ == "__main__":
    unittest.main()
