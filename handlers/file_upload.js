/**
 * file_upload
 * our Request handler.
 */

const async = require("async");
const fs = require("fs");
const path = require("path");
const child_process = require("child_process");

const PathUtils = require("../utils/pathUtils.js");

const ABBootstrap = require("../AppBuilder/ABBootstrap");
// {ABBootstrap}
// responsible for initializing and returning an {ABFactory} that will work
// with the current tenant for the incoming request.

module.exports = {
   /**
    * Key: the cote message key we respond to.
    */
   key: "file_processor.file-upload",

   /**
    * inputValidation
    * define the expected inputs to this service handler:
    * Format:
    * "parameterName" : {
    *    {joi.fn}   : {bool},  // performs: joi.{fn}();
    *    {joi.fn}   : {
    *       {joi.fn1} : true,   // performs: joi.{fn}().{fn1}();
    *       {joi.fn2} : { options } // performs: joi.{fn}().{fn2}({options})
    *    }
    *    // examples:
    *    "required" : {bool},
    *    "optional" : {bool},
    *
    *    // custom:
    *        "validation" : {fn} a function(value, {allValues hash}) that
    *                       returns { error:{null || {new Error("Error Message")} }, value: {normalize(value)}}
    * }
    */
   inputValidation: {
      name: { string: true, required: true },
      object: { string: { uuid: true }, required: true },
      field: { string: true, required: true },
      size: { number: { integer: true }, required: true },
      type: { string: true, required: true },
      fileName: { string: true, required: true },
      uploadedBy: { string: true, required: true },
   },

   /**
    * fn
    * our Request handler.
    * @param {obj} req
    *        the request object sent by the
    *        api_sails/api/controllers/file_processor/file_upload.
    * @param {fn} cb
    *        a node style callback(err, results) to send data when job is finished
    */
   fn: function handler(req, cb) {
      req.log("file_processor.file_upload:");

      // get the AB for the current tenant
      ABBootstrap.init(req)
         .then((AB) => {
            const objID = req.param("object");
            var object = AB.objectByID(objID);
            if (!object) {
               var errObj = new Error(
                  "file_processor.file_upload: unknown object reference"
               );
               req.notify.builder(errObj, {
                  object: req.param("object"),
               });
               cb(errObj);
               return;
            }

            const fieldID = req.param("field");
            if (fieldID != "defaultImage") {
               var field = object.fieldByID(fieldID);
               if (!field) {
                  var errField = new Error(
                     "file_processor.file_upload: unknown field reference"
                  );
                  req.notify.builder(errField, {
                     object,
                     fieldID: req.param("field"),
                     AB: AB,
                  });
                  cb(errField);
                  return;
               }
            }

            const fileName = req.param("name");
            const tempPath = PathUtils.tempPath(req, fileName);
            var pathFile;
            // {string}
            // the path + filename of the stored file

            var destPath = PathUtils.destPath(req);

            async.series(
               {
                  // Scan for malware
                  clamav: (next) => {
                     if (!(process.env.CLAMAV_ENABLED == "true")) {
                        return next();
                     }
                     child_process.execFile(
                        "clamdscan",
                        [tempPath, "--remove=yes", "--quiet"],
                        (err, stdout, stderr) => {
                           if (err) {
                              // ClamAV found a virus
                              if (err.code == 1) {
                                 err.message = "Malware detected in upload";
                              }
                              // Some other system error
                              else {
                                 req.log("Problem running ClamAV");
                                 req.log(stderr);
                              }
                              next(err);
                           } else {
                              next();
                           }
                        }
                     );
                  },

                  // make sure destination directory is created
                  make: (next) => {
                     PathUtils.makePath(destPath, req, next);
                  },

                  // move file to new location
                  move: (next) => {
                     pathFile = path.join(destPath, fileName);
                     fs.rename(tempPath, pathFile, function (err) {
                        if (err) {
                           req.notify.developer(err, {
                              context: `Service:file_processor.file_upload: Error moving file [${tempPath}] -> [${pathFile}] `,
                              tempPath,
                              pathFile,
                           });
                        } else {
                           req.log(
                              `moved file [${tempPath}] -> [${pathFile}] `
                           );
                        }
                        next(err);
                     });
                  },

                  // store file entry in DB
                  uuid: (next) => {
                     // uuid : the fileName without '.ext'
                     // uuid = req.param("name").split(".")[0];

                     var newEntry = {
                        // uuid,
                        file: req.param("fileName"),
                        pathFile,
                        size: req.param("size"),
                        type: req.param("type"),
                        info: req.data,
                        object: objID,
                        field: fieldID,
                        uploadedBy: req.param("uploadedBy"),
                     };
                     var SiteFile = AB.objectFile().model();
                     req.retry(() => SiteFile.create(newEntry))
                        .then(function (entry) {
                           req.log(`file entry saved for [${entry.uuid}]`);
                           next(null, entry.uuid);
                        })
                        .catch(function (err) {
                           req.notify.developer(err, {
                              context:
                                 "Service:file_processor.file_upload: Error updating DB: ",
                              req: req.data,
                           });
                           err.code = 500;
                           next(err);
                        });
                  },
               },
               (err, results) => {
                  if (err) {
                     req.log("Error uploading file:", err);
                     cb(err);
                  } else {
                     cb(null, { uuid: results.uuid });
                  }
               }
            );
         })
         .catch((err) => {
            req.notify.developer(err, {
               context:
                  "Service:file_processor.file_upload: Error initializing ABFactory",
            });
            cb(err);
         });
   },
};
