'use strict';

const validator = require('./utils/validator-extras').validator;
const extendModelValidations = require('./utils/validator-extras').extendModelValidations;
const Utils = require('./utils');
const sequelizeError = require('./errors');
const Promise = require('./promise');
const DataTypes = require('./data-types');
const BelongsTo = require('./associations/belongs-to');
const _ = require('lodash');

/**
 * The Main Instance Validator.
 *
 * @param {Instance} modelInstance The model instance.
 * @param {Object} options A dict with options.
 * @constructor
 * @private
 */
class InstanceValidator {

  constructor(modelInstance, options) {
    options = _.clone(options) || {};

    if (options.fields && !options.skip) {
      options.skip = _.difference(Object.keys(modelInstance.constructor.rawAttributes), options.fields);
    }

    // assign defined and default options
    this.options = _.defaults(options, {
      skip: [],
      hooks: true
    });

    this.modelInstance = modelInstance;

    /**
     * Exposes a reference to validator.js. This allows you to add custom validations using `validator.extend`
     * @name validator
     * @private
     */
    this.validator = validator;

    /**
     *  All errors will be stored here from the validations.
     *
     * @type {Array} Will contain keys that correspond to attributes which will
     *   be Arrays of Errors.
     * @private
     */
    this.errors = [];

    /**
     * @type {boolean} Indicates if validations are in progress
     * @private
     */
    this.inProgress = false;

    extendModelValidations(modelInstance);
  }

  /**
   * The main entry point for the Validation module, invoke to start the dance.
   *
   * @return {Promise}
   * @private
   */
  _validate() {
    if (this.inProgress) {
      throw new Error('Validations already in progress.');
    }
    this.inProgress = true;

    return Promise.all(
      [this._builtinValidators(), this._customValidators()].map(promise => promise.reflect())
    ).then(() => {
      if (this.errors.length) {
        throw new sequelizeError.ValidationError(null, this.errors);
      }
    });
  }

  /**
   * Invoke the Validation sequence and run validation hooks if defined
   *   - Before Validation Model Hooks
   *   - Validation
   *   - On validation success: After Validation Model Hooks
   *   - On validation failure: Validation Failed Model Hooks
   *
   * @return {Promise}
   * @private
   */
  validate() {
    return this.options.hooks ? this._validateAndRunHooks() : this._validate();
  }

  /**
   * Invoke the Validation sequence and run hooks
   *   - Before Validation Model Hooks
   *   - Validation
   *   - On validation success: After Validation Model Hooks
   *   - On validation failure: Validation Failed Model Hooks
   *
   * @return {Promise}
   * @private
   */
  _validateAndRunHooks() {
    const runHooks = this.modelInstance.constructor.runHooks.bind(this.modelInstance.constructor);
    return runHooks('beforeValidate', this.modelInstance, this.options)
      .then(() =>
        this._validate()
          .catch(error => runHooks('validationFailed', this.modelInstance, this.options, error)
            .then(newError => { throw newError || error; }))
      )
      .then(() => runHooks('afterValidate', this.modelInstance, this.options))
      .return(this.modelInstance);
  }

  /**
   * Will run all the built-in validators.
   *
   * @return {Promise(Array.<Promise.PromiseInspection>)} A promise from .reflect().
   * @private
   */
  _builtinValidators() {
    // promisify all attribute invocations
    const validators = [];
    _.forIn(this.modelInstance.rawAttributes, (rawAttribute, field) => {
      if (this.options.skip.indexOf(field) >= 0) {
        return;
      }

      const value = this.modelInstance.dataValues[field];

      if (!rawAttribute._autoGenerated && !rawAttribute.autoIncrement) {
        // perform validations based on schema
        this._validateSchema(rawAttribute, field, value);
      }

      if (this.modelInstance.validators.hasOwnProperty(field)) {
        validators.push(this._builtinAttrValidate.call(this, value, field).reflect());
      }
    });

    return Promise.all(validators);
  }

  /**
   * Will run all the custom validators.
   *
   * @return {Promise(Array.<Promise.PromiseInspection>)} A promise from .reflect().
   * @private
   */
  _customValidators() {
    const validators = [];
    _.each(this.modelInstance._modelOptions.validate, (validator, validatorType) => {
      if (this.options.skip.indexOf(validatorType) >= 0) {
        return;
      }

      const valprom = this._invokeCustomValidator(validator, validatorType)
        // errors are handled in settling, stub this
        .catch(() => {})
        .reflect();

      validators.push(valprom);
    });

    return Promise.all(validators);
  }

  /**
   * Validate a single attribute with all the defined built-in validators.
   *
   * @param {*} value Anything.
   * @param {string} field The field name.
   * @return {Promise} A promise, will always resolve,
   *   auto populates error on this.error local object.
   * @private
   */
  _builtinAttrValidate(value, field) {
    // check if value is null (if null not allowed the Schema pass will capture it)
    if (value === null || typeof value === 'undefined') {
      return Promise.resolve();
    }

    // Promisify each validator
    const validators = [];
    _.forIn(this.modelInstance.validators[field], (test, validatorType) => {

      if (['isUrl', 'isURL', 'isEmail'].indexOf(validatorType) !== -1) {
        // Preserve backwards compat. Validator.js now expects the second param to isURL and isEmail to be an object
        if (typeof test === 'object' && test !== null && test.msg) {
          test = {
            msg: test.msg
          };
        } else if (test === true) {
          test = {};
        }
      }

      // Check for custom validator.
      if (typeof test === 'function') {
        return validators.push(this._invokeCustomValidator(test, validatorType, true, value, field).reflect());
      }

      const validatorPromise = this._invokeBuiltinValidator(value, test, validatorType, field);
      // errors are handled in settling, stub this
      validatorPromise.catch(() => {});
      validators.push(validatorPromise.reflect());
    });

    return Promise
      .all(validators)
      .then(results => this._handleReflectedResult(field, value, results));
  }

  /**
   * Prepare and invoke a custom validator.
   *
   * @param {Function} validator The custom validator.
   * @param {string} validatorType the custom validator type (name).
   * @param {boolean=} optAttrDefined Set to true if custom validator was defined
   *   from the Attribute
   * @return {Promise} A promise.
   * @private
   */
  _invokeCustomValidator(validator, validatorType, optAttrDefined, optValue, optField) {
    let validatorFunction = null;  // the validation function to call
    let isAsync = false;

    const validatorArity = validator.length;
    // check if validator is async and requires a callback
    let asyncArity = 1;
    let errorKey = validatorType;
    let invokeArgs;
    if (optAttrDefined) {
      asyncArity = 2;
      invokeArgs = optValue;
      errorKey = optField;
    }
    if (validatorArity === asyncArity) {
      isAsync = true;
    }

    if (isAsync) {
      if (optAttrDefined) {
        validatorFunction = Promise.promisify(validator.bind(this.modelInstance, invokeArgs));
      } else {
        validatorFunction = Promise.promisify(validator.bind(this.modelInstance));
      }
      return validatorFunction()
        .catch(e => this._pushError(false, errorKey, e, optValue, validatorType));
    } else {
      return Promise
        .try(() => validator.call(this.modelInstance, invokeArgs))
        .catch(e => this._pushError(false, errorKey, e, optValue, validatorType));
    }
  }

  /**
   * Prepare and invoke a build-in validator.
   *
   * @param {*} value Anything.
   * @param {*} test The test case.
   * @param {string} validatorType One of known to Sequelize validators.
   * @param {string} field The field that is being validated
   * @return {Object} An object with specific keys to invoke the validator.
   * @private
   */
  _invokeBuiltinValidator(value, test, validatorType, field) {
    return Promise.try(() => {
      // Cast value as string to pass new Validator.js string requirement
      const valueString = String(value);
      // check if Validator knows that kind of validation test
      if (typeof validator[validatorType] !== 'function') {
        throw new Error('Invalid validator function: ' + validatorType);
      }

      const validatorArgs = this._extractValidatorArgs(test, validatorType, field);

      if (!validator[validatorType].apply(validator, [valueString].concat(validatorArgs))) {
        throw Object.assign(new Error(test.msg || `Validation ${validatorType} on ${field} failed`), { validatorName: validatorType, validatorArgs });
      }
    });
  }

  /**
   * Will extract arguments for the validator.
   *
   * @param {*} test The test case.
   * @param {string} validatorType One of known to Sequelize validators.
   * @param {string} field The field that is being validated.
   * @private
   */
  _extractValidatorArgs(test, validatorType, field) {
    let validatorArgs = test.args || test;
    const isLocalizedValidator = typeof validatorArgs !== 'string' && (validatorType === 'isAlpha' || validatorType === 'isAlphanumeric' || validatorType === 'isMobilePhone');

    if (!Array.isArray(validatorArgs)) {
      if (validatorType === 'isImmutable') {
        validatorArgs = [validatorArgs, field];
      } else if (isLocalizedValidator || validatorType === 'isIP') {
        validatorArgs = [];
      } else {
        validatorArgs = [validatorArgs];
      }
    } else {
      validatorArgs = validatorArgs.slice(0);
    }
    return validatorArgs;
  }

  /**
   * Will validate a single field against its schema definition (isnull).
   *
   * @param {Object} rawAttribute As defined in the Schema.
   * @param {string} field The field name.
   * @param {*} value anything.
   * @private
   */
  _validateSchema(rawAttribute, field, value) {
    if (rawAttribute.allowNull === false && (value === null || value === undefined)) {
      const association = _.values(this.modelInstance.constructor.associations).find(association => association instanceof BelongsTo && association.foreignKey === rawAttribute.fieldName);
      if (!association || !this.modelInstance.get(association.associationAccessor)) {
        const validators = this.modelInstance.validators[field];
        const errMsg = _.get(validators, 'notNull.msg', `${this.modelInstance.constructor.name}.${field} cannot be null`);

        this.errors.push(new sequelizeError.ValidationErrorItem(
          errMsg,
          'notNull Violation', // sequelizeError.ValidationErrorItem.Origins.CORE,
          field,
          value,
          this.modelInstance,
          'is_null'
        ));
      }
    }

    if (rawAttribute.type === DataTypes.STRING || rawAttribute.type instanceof DataTypes.STRING || rawAttribute.type === DataTypes.TEXT || rawAttribute.type instanceof DataTypes.TEXT) {
      if (Array.isArray(value) || _.isObject(value) && !(value instanceof Utils.SequelizeMethod) && !Buffer.isBuffer(value)) {
        this.errors.push(new sequelizeError.ValidationErrorItem(
          `${field} cannot be an array or an object`,
          'string violation', // sequelizeError.ValidationErrorItem.Origins.CORE,
          field,
          value,
          this.modelInstance,
          'not_a_string'
        ));
      }
    }
  }


  /**
   * Handles the returned result of a Promise.reflect.
   *
   * If errors are found it populates this.error.
   *
   * @param {string} field The attribute name.
   * @param {string|number} value The data value.
   * @param {Array.<Promise.PromiseInspection>} Promise inspection objects.
   * @private
   */
  _handleReflectedResult(field, value, promiseInspections) {
    for (const promiseInspection of promiseInspections) {
      if (promiseInspection.isRejected()) {
        const rejection = promiseInspection.error();
        const isBuiltIn = !!rejection.validatorName;

        this._pushError(isBuiltIn, field, rejection, value, rejection.validatorName, rejection.validatorArgs);
      }
    }
  }

  /**
   * Signs all errors retaining the original.
   *
   * @param {Boolean}       isBuiltin   - Determines if error is from builtin validator.
   * @param {String}        errorKey    - name of invalid attribute.
   * @param {Error|String}  rawError    - The original error.
   * @param {String|Number} value       - The data that triggered the error.
   * @param {String}        fnName      - Name of the validator, if any
   * @param {Array}         fnArgs      - Arguments for the validator [function], if any
   *
   * @private
   */
  _pushError(isBuiltin, errorKey, rawError, value, fnName, fnArgs) {
    const message = rawError.message || rawError || 'Validation error';
    const error = new sequelizeError.ValidationErrorItem(
      message,
      'Validation error', // sequelizeError.ValidationErrorItem.Origins.FUNCTION,
      errorKey,
      value,
      this.modelInstance,
      fnName,
      isBuiltin ? fnName : undefined,
      isBuiltin ? fnArgs : undefined
    );

    error[InstanceValidator.RAW_KEY_NAME] = rawError;

    this.errors.push(error);
  }
}
/**
 * @define {string} The error key for arguments as passed by custom validators
 * @private
 */
InstanceValidator.RAW_KEY_NAME = 'original';

module.exports = InstanceValidator;
module.exports.InstanceValidator = InstanceValidator;
module.exports.default = InstanceValidator;
