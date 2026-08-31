from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_contracts


class AgentContractsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.skills = self.root / "skills"
        self.contracts = self.root / "contracts"
        skill = self.skills / "sample-skill"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("# Sample\n\nDo the bounded sync.\n", encoding="utf-8")
        (self.root / "precheck.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.job = {
            "id": "job-123",
            "prompt": "Use the sample skill and sync once.",
            "skills": ["sample-skill"],
            "script": "precheck.sh",
            "workdir": str(self.root),
            "no_agent": False,
        }
        self.environment = patch.dict(
            os.environ,
            {"FLUID_AUTOMATION_CONTRACT_DIR": str(self.contracts)},
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def create_contract(self):
        contract = agent_contracts.build_contract(
            self.job,
            automation_key="sample-sync",
            subject_types=["signal"],
            display_name="Sample Sync",
            summary="Syncs sample records.",
            steps=["Run the bounded sync once."],
            icon="↻",
            skill_roots=[self.skills],
        )
        agent_contracts.write_contract(contract)
        return contract

    def test_verified_contract_matches_prompt_skill_and_script(self) -> None:
        contract = self.create_contract()
        verified, status = agent_contracts.verified_contract(
            self.job,
            skill_roots=[self.skills],
        )
        self.assertEqual(status, "verified")
        self.assertIsNotNone(verified)
        self.assertEqual(verified["definitionHash"], contract["definitionHash"])
        self.assertEqual(verified["steps"], ["Run the bounded sync once."])
        self.assertEqual(verified["automationKey"], "sample-sync")
        self.assertEqual(verified["subjectTypes"], ["signal"])

    def test_prompt_change_invalidates_contract(self) -> None:
        self.create_contract()
        self.job["prompt"] = "Use the sample skill and sync twice."
        verified, status = agent_contracts.verified_contract(
            self.job,
            skill_roots=[self.skills],
        )
        self.assertIsNone(verified)
        self.assertEqual(status, "stale")

    def test_skill_change_invalidates_contract(self) -> None:
        self.create_contract()
        (self.skills / "sample-skill" / "SKILL.md").write_text(
            "# Sample\n\nUse a different operation.\n",
            encoding="utf-8",
        )
        verified, status = agent_contracts.verified_contract(
            self.job,
            skill_roots=[self.skills],
        )
        self.assertIsNone(verified)
        self.assertEqual(status, "stale")

    def test_missing_skill_prevents_contract_creation(self) -> None:
        self.job["skills"] = ["missing-skill"]
        with self.assertRaisesRegex(ValueError, "definition sources unavailable"):
            agent_contracts.build_contract(
                self.job,
                automation_key="sample-sync",
                subject_types=["signal"],
                display_name="Sample Sync",
                summary="Syncs sample records.",
                steps=[],
                skill_roots=[self.skills],
            )

    def test_invalid_automation_key_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "automationKey is invalid"):
            agent_contracts.build_contract(
                self.job,
                automation_key="Sample Sync",
                subject_types=["signal"],
                display_name="Sample Sync",
                summary="Syncs sample records.",
                steps=[],
                skill_roots=[self.skills],
            )

    def test_unknown_subject_type_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported subjectTypes"):
            agent_contracts.build_contract(
                self.job,
                automation_key="sample-sync",
                subject_types=["deal"],
                display_name="Sample Sync",
                summary="Syncs sample records.",
                steps=[],
                skill_roots=[self.skills],
            )

    def test_duplicate_automation_keys_are_reported(self) -> None:
        self.assertEqual(
            agent_contracts.duplicate_automation_keys([
                {"automationKey": "sample-sync"},
                {"automationKey": "another-sync"},
                {"automationKey": "sample-sync"},
            ]),
            ["sample-sync"],
        )


if __name__ == "__main__":
    unittest.main()
