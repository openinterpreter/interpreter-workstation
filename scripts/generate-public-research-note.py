#!/usr/bin/env python3
"""Generate the original PDF used by the built-in marketing demo."""

from pathlib import Path
import sys

from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    "apps/interpreter-marketing-demo/public/papers/pi0-general-robot-control.pdf"
)

# Stable metadata and document IDs keep fixture regeneration reproducible.
rl_config.invariant = 1

INK = colors.HexColor("#162033")
MUTED = colors.HexColor("#5F6B7A")
ACCENT = colors.HexColor("#6C5CE7")
PALE = colors.HexColor("#F2F0FF")
LINE = colors.HexColor("#D9DDE5")


def footer(canvas, document):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(0.7 * inch, 0.58 * inch, 7.8 * inch, 0.58 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(0.7 * inch, 0.38 * inch, "Interpreter Workstation synthetic research-note fixture")
    canvas.drawRightString(7.8 * inch, 0.38 * inch, f"Page {document.page}")
    canvas.restoreState()


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=28,
        leading=33,
        textColor=INK,
        alignment=TA_CENTER,
        spaceAfter=14,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=12,
        leading=18,
        textColor=MUTED,
        alignment=TA_CENTER,
        spaceAfter=18,
    )
    heading = ParagraphStyle(
        "Heading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=17,
        leading=21,
        textColor=INK,
        spaceBefore=10,
        spaceAfter=8,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=16,
        textColor=INK,
        spaceAfter=9,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.5,
        leading=12,
        textColor=MUTED,
    )

    document = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        rightMargin=0.75 * inch,
        leftMargin=0.75 * inch,
        topMargin=0.72 * inch,
        bottomMargin=0.78 * inch,
        title="Research Notes: Generalist Robot Control",
        author="Open Interpreter contributors",
        subject="Original synthetic fixture for desktop UI testing",
    )

    story = [
        Spacer(1, 0.38 * inch),
        Paragraph("RESEARCH NOTE", ParagraphStyle("Label", parent=small, textColor=ACCENT, alignment=TA_CENTER, fontName="Helvetica-Bold", spaceAfter=8)),
        Paragraph("Generalist Robot Control", title),
        Paragraph("A compact evaluation brief for vision-language-action systems", subtitle),
        Table(
            [[Paragraph("ORIGINAL TEST FIXTURE", ParagraphStyle("Badge", parent=small, textColor=ACCENT, alignment=TA_CENTER, fontName="Helvetica-Bold"))]],
            colWidths=[2.15 * inch],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]),
            hAlign="CENTER",
        ),
        Spacer(1, 0.28 * inch),
        Paragraph("About this document", heading),
        Paragraph(
            "This document is an original, synthetic fixture created for testing PDF display, search, citations, and workspace navigation in Interpreter Workstation. It is not the original pi0 paper and contains no copied figures or passages.",
            body,
        ),
        Paragraph("Research frame", heading),
        Paragraph(
            "Generalist robot policies aim to connect visual observations and natural-language instructions to continuous actions across tasks, environments, and robot embodiments. The useful product question is not whether one benchmark improves, but whether the system transfers reliably while remaining observable and safe.",
            body,
        ),
        Table(
            [
                ["Dimension", "Question for evaluation"],
                ["Transfer", "Does behavior carry to unseen objects, scenes, and embodiments?"],
                ["Instruction", "Can the policy preserve user intent across a long action sequence?"],
                ["Recovery", "Can it detect drift and recover without compounding errors?"],
                ["Safety", "Are consequential actions bounded by explicit policy and review?"],
            ],
            colWidths=[1.25 * inch, 5.45 * inch],
            repeatRows=1,
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), INK),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("LEADING", (0, 0), (-1, -1), 13),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]),
        ),
        PageBreak(),
        Paragraph("Evaluation plan", title),
        Paragraph("1. Establish the operating envelope", heading),
        Paragraph(
            "Record the robot embodiment, camera geometry, control frequency, supported instruction types, and assumptions about scene structure. A result without this context is difficult to compare or reproduce.",
            body,
        ),
        Paragraph("2. Separate capability from reliability", heading),
        Paragraph(
            "Measure whether a task can be completed at all, then measure repeatability, recovery time, intervention rate, and failure severity. A compelling single trajectory is demonstration evidence, not a reliability estimate.",
            body,
        ),
        Paragraph("3. Preserve action-level evidence", heading),
        Paragraph(
            "Keep synchronized observations, model decisions, low-level actions, policy checks, and operator interventions. This supports debugging and allows reviewers to distinguish perception errors from planning and control errors.",
            body,
        ),
        Paragraph("Suggested scorecard", heading),
        Table(
            [
                ["Metric", "Unit", "Why it matters"],
                ["Task completion", "% trials", "Measures usable end-state success"],
                ["Intervention rate", "per hour", "Captures practical supervision burden"],
                ["Recovery success", "% recoveries", "Tests resilience after detectable drift"],
                ["Unsafe action rate", "per 1,000 actions", "Surfaces policy and control failures"],
                ["Median latency", "milliseconds", "Connects model quality to interactive control"],
            ],
            colWidths=[1.6 * inch, 1.2 * inch, 3.9 * inch],
            repeatRows=1,
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("GRID", (0, 0), (-1, -1), 0.5, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]),
        ),
        PageBreak(),
        Paragraph("Integration notes", title),
        Paragraph("Product implications", heading),
        Paragraph(
            "A workstation that coordinates computer and robot actions should expose the same core controls: scoped permissions, observable plans, interruptible execution, durable logs, and explicit review for consequential steps. Model capability does not replace these controls.",
            body,
        ),
        Paragraph("Questions to carry forward", heading),
        Paragraph(
            "- Which failures can be detected before an irreversible action?<br/>"
            "- Which state must be durable across pauses and machine restarts?<br/>"
            "- How should human steering alter an in-flight plan?<br/>"
            "- Which evidence should be attached to a demo, benchmark, or incident report?",
            body,
        ),
        Paragraph("Bibliographic pointer", heading),
        Paragraph(
            "This synthetic note is inspired by the public research topic represented by: Kevin Black et al., <i>pi0: A Vision-Language-Action Flow Model for General Robot Control</i>, arXiv:2410.24164. Source page: https://arxiv.org/abs/2410.24164",
            body,
        ),
        Spacer(1, 0.2 * inch),
        Table(
            [[Paragraph("No original paper pages, figures, tables, or prose are embedded in this fixture.", ParagraphStyle("Callout", parent=body, textColor=INK, alignment=TA_CENTER, fontName="Helvetica-Bold", spaceAfter=0))]],
            colWidths=[6.2 * inch],
            style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.8, ACCENT),
                ("TOPPADDING", (0, 0), (-1, -1), 13),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 13),
            ]),
        ),
    ]

    document.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    build()
    print(f"Generated {OUTPUT}")
