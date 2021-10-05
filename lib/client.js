const axios = require("axios");
const JsonCycle = require("json-cycle");
const { URL } = require("url");
const createCallsiteRecord = require("callsite-record");

const { sep } = require("path");
const chalk = require("chalk");
const { uploadFile } = require("./fileUploader");
const { PASSED, FAILED, APP_PREFIX } = require("./constants");

const TESTOMAT_URL = process.env.TESTOMATIO_URL || "https://app.testomat.io";
const { TESTOMATIO_RUNGROUP_TITLE, TESTOMATIO_ENV, TESTOMATIO_RUN } = process.env;


if (TESTOMATIO_RUN) {
  process.env.runId = TESTOMATIO_RUN;
}

class TestomatClient {
  /**
   * Create a Testomat client instance
   *
   * @param {*} params
   */
  constructor(params) {
    this.apiKey = params.apiKey || process.env.TESTOMATIO;
    this.title = params.title || process.env.TESTOMATIO_TITLE;
    this.parallel = params.parallel;
    this.runId = process.env.runId;
    this.queue = Promise.resolve();
    this.axios = axios.create();
  }

  /**
   * Used to create a new Test run
   *
   * @returns {Promise} - resolves to Run id which should be used to update / add test
   */
  createRun() {
    const { runId } = process.env;
    const runParams = {
      api_key: this.apiKey.trim(),
      title: this.title,
      parallel: this.parallel,
      group_title: TESTOMATIO_RUNGROUP_TITLE,
      env: TESTOMATIO_ENV,
    };
    if (!isValidUrl(TESTOMAT_URL.trim())) {
      console.log(
        APP_PREFIX,
        chalk.red(`Error creating report on Testomat.io, report url '${TESTOMAT_URL}' is invalid`)
      );
      return;
    }

    if (runId) {
      this.runId = runId;
      this.queue = this.queue.then(() =>
        axios.put(`${TESTOMAT_URL.trim()}/api/reporter/${runId}`, runParams));
      return Promise.resolve(runId);
    }

    this.queue = this.queue
      .then(() =>
        this.axios
          .post(`${TESTOMAT_URL.trim()}/api/reporter`, runParams)
          .then((resp) => {
            this.runId = resp.data.uid;
            this.runUrl = `${TESTOMAT_URL}/${resp.data.url
              .split("/")
              .splice(3)
              .join("/")}`;
            console.log(
              APP_PREFIX,
              "📊 Report created. Report ID:",
              this.runId
            );
            process.env.runId = this.runId;
          }))
      .catch(() => {
        console.log(
          APP_PREFIX,
          "Error creating report Testomat.io, please check if your API key is valid. Skipping report"
        );
      });

    return this.queue;
  }

  /**
   * Used to add a new test to Run instance
   *
   * @returns {Promise}
   */
  async addTestRun(testId, status, testData = {}) {
    let {
      message = "",
      error = "",
      time = "",
      example = null,
      files = [],
      steps,
      title,
      suite_title,
      suite_id,
      test_id,
    } = testData;

    const uploadedFiles = [];

    if (testId) testData.test_id = testId;

    let stack = "";

    if (error) {
      if (!message) message = error.message;
      if (error.inspect) message = error.inspect();

      stack = `\n${chalk.bold(message)}\n`;

      // diffs for mocha, cypress, codeceptjs style
      if (error.actual && error.expected) {
        stack += `\n\n${chalk.bold.green("+ expected")} ${chalk.bold.red(
          "- actual"
        )}`;
        stack += `\n${chalk.red(
          `- ${error.actual.toString().split("\n").join("\n- ")}`
        )}`;
        stack += `\n${chalk.green(
          `+ ${error.expected.toString().split("\n").join("\n+ ")}`
        )}`;
        stack += "\n\n";
      }

      try {
        const record = createCallsiteRecord({
          forError: error,
        });
        if (record) {
          stack += record.renderSync({
            stackFilter: (frame) =>
              frame.getFileName().indexOf(sep) > -1 &&
              frame.getFileName().indexOf("node_modules") < 0 &&
              frame.getFileName().indexOf("internal") < 0,
          });
        }
      } catch (e) {
        console.log(e);
      }
    }
    if (steps) {
      stack = stack
        ? `${steps}\n\n${chalk.bold.red(
          "################[ Failure ]################"
        )}\n${stack}`
        : steps;
    }

    if (this.runId) {
      for (const file of files) {
        uploadedFiles.push(uploadFile(file, this.runId));
      }
    }

    this.queue = this.queue
      .then(async () => {
        if (!this.runId) return;
        const json = JsonCycle.stringify({
          api_key: this.apiKey,
          files,
          steps,
          status,
          stack,
          example,
          title,
          suite_title,
          suite_id,
          test_id,
          message,
          run_time: time,
          artifacts: await Promise.all(uploadedFiles),
        });
        return this.axios.post(
          `${TESTOMAT_URL}/api/reporter/${this.runId}/testrun`,
          json,
          {
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: {
              // Overwrite Axios's automatically set Content-Type
              "Content-Type": "application/json",
            },
          }
        );
      })
      .catch((err) => {
        if (err.response) {
          if (err.response.status >= 400) {
            const data = err.response.data || { message: '' };
            console.log(
              APP_PREFIX,
              chalk.blue(title),
              `Report couldn't be processed: (${err.response.status}) ${data.message}`
            );
            return;
          }
          console.log(
            APP_PREFIX,
            chalk.blue(title),
            `Report couldn't be processed: ${err.response.data.message}`
          );
        } else {
          console.log(APP_PREFIX, chalk.blue(title), "Report couldn't be processed", err);
        }
      });

    return this.queue;
  }

  /**
   * Update run status
   *
   * @returns {Promise}
   */
  updateRunStatus(status, isParallel) {
    this.queue = this.queue
      .then(async () => {
        if (this.runId) {
          let statusEvent;
          if (status === PASSED) statusEvent = "pass";
          if (status === FAILED) statusEvent = "fail";
          if (isParallel) statusEvent += "_parallel";
          await this.axios.put(`${TESTOMAT_URL}/api/reporter/${this.runId}`, {
            api_key: this.apiKey,
            status_event: statusEvent,
            status,
          });
          if (this.runUrl) {
            console.log(
              APP_PREFIX,
              "📊 Report Saved. Report URL:",
              chalk.magenta(this.runUrl)
            );
          }
        }
      })
      .catch((err) => {
        console.log(APP_PREFIX, "Error updating status, skipping...", err);
      });
    return this.queue;
  }
}

module.exports = TestomatClient;

function isValidUrl(s) {
  try {
    new URL(s); // eslint-disable-line
    return true;
  } catch (err) {
    return false;
  }
}
